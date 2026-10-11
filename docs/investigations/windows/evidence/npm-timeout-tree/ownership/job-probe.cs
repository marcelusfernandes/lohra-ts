// Issue #882: bancada descartável, não é helper de produção.
// Todas as operações de término usam handles abertos por esta sonda.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public sealed class JobProbeResult {
    public string Mode { get; set; }
    public bool ParentAlreadyInJob { get; set; }
    public bool CreatedSuspended { get; set; }
    public int CreateError { get; set; }
    public bool MarkerBeforeResume { get; set; }
    public bool Assigned { get; set; }
    public int AssignError { get; set; }
    public bool Resumed { get; set; }
    public int ResumeError { get; set; }
    public int ActiveBefore { get; set; }
    public int ActiveAfter { get; set; }
    public int TotalAssociated { get; set; }
    public bool QueryFailureObserved { get; set; }
    public int QueryError { get; set; }
    public bool TerminationFailureObserved { get; set; }
    public int TerminationError { get; set; }
    public bool OwnJobTerminated { get; set; }
    public bool MiddleMarker { get; set; }
    public bool ChildMarker { get; set; }
    public bool LateMarker { get; set; }
    public bool ExternalControlMarker { get; set; }
    public long CreateMs { get; set; }
    public long AssignMs { get; set; }
    public long ResumeMs { get; set; }
    public long TotalMs { get; set; }
    public string Failure { get; set; }
}

public static class OwnedJobProbe {
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    private const int PROC_THREAD_ATTRIBUTE_JOB_LIST = 0x0002000D;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const uint WAIT_OBJECT_0 = 0;
    private const uint WAIT_TIMEOUT = 258;
    private const int JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION = 1;
    private const int JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO {
        public uint cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars;
        public uint dwFillAttribute, dwFlags;
        public ushort wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFOEX {
        public STARTUPINFO StartupInfo;
        public IntPtr AttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION {
        public IntPtr hProcess, hThread;
        public uint dwProcessId, dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BASIC_LIMIT {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct EXTENDED_LIMIT {
        public BASIC_LIMIT BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BASIC_ACCOUNTING {
        public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref EXTENDED_LIMIT info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out BASIC_ACCOUNTING info, uint length, IntPtr returnLength);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool inJob);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessW(string application, StringBuilder commandLine,
        IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags,
        IntPtr environment, string currentDirectory, ref STARTUPINFO startup, out PROCESS_INFORMATION process);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "CreateProcessW")]
    private static extern bool CreateProcessEx(string application, StringBuilder commandLine,
        IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags,
        IntPtr environment, string currentDirectory, ref STARTUPINFOEX startup, out PROCESS_INFORMATION process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute,
        IntPtr value, UIntPtr size, IntPtr previous, IntPtr previousSize);
    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private static int Error() { return Marshal.GetLastWin32Error(); }
    private static bool Has(string dir, string file) { return File.Exists(Path.Combine(dir, file)); }
    private static void Require(bool ok, string step) {
        if (!ok) throw new InvalidOperationException(step + ":win32=" + Error());
    }
    private static BASIC_ACCOUNTING Accounting(IntPtr job) {
        BASIC_ACCOUNTING info;
        Require(QueryInformationJobObject(job, JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION,
            out info, (uint)Marshal.SizeOf(typeof(BASIC_ACCOUNTING)), IntPtr.Zero), "query");
        return info;
    }
    private static bool AwaitMarker(string dir, string name, long deadlineTicks) {
        while (Stopwatch.GetTimestamp() < deadlineTicks) {
            if (Has(dir, name)) return true;
            Thread.Sleep(20);
        }
        return Has(dir, name);
    }
    private static bool AwaitEmpty(IntPtr job, long deadlineTicks) {
        while (Stopwatch.GetTimestamp() < deadlineTicks) {
            if (Accounting(job).ActiveProcesses == 0) return true;
            Thread.Sleep(20);
        }
        return Accounting(job).ActiveProcesses == 0;
    }
    private static long Deadline(int ms) { return Stopwatch.GetTimestamp() + (long)ms * Stopwatch.Frequency / 1000; }

    // Apenas argumentos controlados pela sonda. O transporte genérico é #884.
    private static string Quote(string value) { return "\"" + value.Replace("\"", "\\\"") + "\""; }

    // Alternativa de desenho: job já associado pelo kernel no retorno de CreateProcess.
    // Só a sonda controlada; não é implementação do helper #883.
    public static JobProbeResult RunAtomic(string node, string npmCli, string dir, bool invalidJob) {
        var result = new JobProbeResult { Mode = invalidJob ? "atomic-invalid-job" : "atomic-normal" };
        var whole = Stopwatch.StartNew();
        IntPtr job = IntPtr.Zero, attributes = IntPtr.Zero, jobs = IntPtr.Zero;
        PROCESS_INFORMATION child = new PROCESS_INFORMATION();
        bool created = false, initialized = false;
        try {
            bool currentInJob;
            Require(IsProcessInJob(GetCurrentProcess(), IntPtr.Zero, out currentInJob), "is-process-in-job");
            result.ParentAlreadyInJob = currentInJob;
            job = CreateJobObject(IntPtr.Zero, null);
            Require(job != IntPtr.Zero, "create-job");
            var limit = new EXTENDED_LIMIT();
            limit.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            Require(SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, ref limit,
                (uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT))), "set-kill-on-close");
            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            if (size == IntPtr.Zero) throw new InvalidOperationException("attribute-size:win32=" + Error());
            attributes = Marshal.AllocHGlobal(size);
            Require(InitializeProcThreadAttributeList(attributes, 1, 0, ref size), "initialize-attributes");
            initialized = true;
            jobs = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(jobs, invalidJob ? IntPtr.Zero : job);
            Require(UpdateProcThreadAttribute(attributes, 0, new IntPtr(PROC_THREAD_ATTRIBUTE_JOB_LIST),
                jobs, new UIntPtr((uint)IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "update-job-list");
            var startup = new STARTUPINFOEX();
            startup.StartupInfo.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFOEX));
            startup.AttributeList = attributes;
            var command = new StringBuilder(Quote(node) + " " + Quote(npmCli) + " run --silent probe");
            var timer = Stopwatch.StartNew();
            bool createdNow = CreateProcessEx(node, command, IntPtr.Zero, IntPtr.Zero, false,
                CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT,
                IntPtr.Zero, dir, ref startup, out child);
            result.CreateMs = timer.ElapsedMilliseconds;
            if (!createdNow) {
                result.CreateError = Error();
                if (!invalidJob) throw new InvalidOperationException("create-with-job-list:win32=" + result.CreateError);
                result.ActiveAfter = (int)Accounting(job).ActiveProcesses;
                return result;
            }
            created = true;
            result.CreatedSuspended = true;
            result.MarkerBeforeResume = Has(dir, "middle-started");
            result.ActiveBefore = (int)Accounting(job).ActiveProcesses;
            if (invalidJob) throw new InvalidOperationException("invalid-job-accepted");
            bool inside;
            result.Assigned = result.ActiveBefore == 1 &&
                IsProcessInJob(child.hProcess, job, out inside) && inside;
            if (!result.Assigned) throw new InvalidOperationException("not-in-job-at-create-return");
            uint previous = ResumeThread(child.hThread);
            if (previous == 0xffffffff) throw new InvalidOperationException("resume:win32=" + Error());
            result.Resumed = true;
            uint waited = WaitForSingleObject(child.hProcess, 4500);
            if (waited != WAIT_OBJECT_0) throw new InvalidOperationException("atomic-parent-wait=" + waited);
            if (!AwaitEmpty(job, Deadline(2500))) throw new InvalidOperationException("atomic-job-not-empty");
            var accounting = Accounting(job);
            result.ActiveAfter = (int)accounting.ActiveProcesses;
            result.TotalAssociated = (int)accounting.TotalProcesses;
            result.MiddleMarker = Has(dir, "middle-started");
            result.ChildMarker = Has(dir, "child-started");
            result.LateMarker = Has(dir, "child-late");
        } catch (Exception error) {
            result.Failure = error.GetType().Name + ":" + error.Message;
        } finally {
            if (job != IntPtr.Zero) CloseHandle(job);
            if (created) { CloseHandle(child.hThread); CloseHandle(child.hProcess); }
            if (initialized) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (jobs != IntPtr.Zero) Marshal.FreeHGlobal(jobs);
            result.TotalMs = whole.ElapsedMilliseconds;
        }
        return result;
    }

    public static JobProbeResult Run(string node, string npmCli, string dir, string mode) {
        var result = new JobProbeResult { Mode = mode };
        var whole = Stopwatch.StartNew();
        IntPtr job = IntPtr.Zero;
        PROCESS_INFORMATION child = new PROCESS_INFORMATION();
        bool created = false;
        Process external = null;
        try {
            bool currentInJob;
            Require(IsProcessInJob(GetCurrentProcess(), IntPtr.Zero, out currentInJob), "is-process-in-job");
            result.ParentAlreadyInJob = currentInJob;
            job = CreateJobObject(IntPtr.Zero, null);
            Require(job != IntPtr.Zero, "create-job");
            var limit = new EXTENDED_LIMIT();
            limit.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            Require(SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, ref limit,
                (uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT))), "set-kill-on-close");

            if (mode == "timeout") {
                var control = new ProcessStartInfo(node, Quote(Path.Combine(dir, "control.cjs")));
                control.WorkingDirectory = dir;
                control.UseShellExecute = false;
                control.CreateNoWindow = true;
                control.Environment["PROBE_DIR"] = dir;
                external = Process.Start(control);
                if (external == null) throw new InvalidOperationException("control-start-null");
            }

            var startup = new STARTUPINFO();
            startup.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO));
            var command = new StringBuilder(Quote(node) + " " + Quote(npmCli) + " run --silent probe");
            var timer = Stopwatch.StartNew();
            bool createdNow = CreateProcessW(mode == "create-failure" ? Path.Combine(dir, "absent-node.exe") : node,
                command, IntPtr.Zero, IntPtr.Zero, false, CREATE_SUSPENDED | CREATE_NO_WINDOW,
                IntPtr.Zero, dir, ref startup, out child);
            if (!createdNow) {
                result.CreateError = Error();
                if (mode != "create-failure") throw new InvalidOperationException("create-suspended:win32=" + result.CreateError);
                result.ActiveAfter = (int)Accounting(job).ActiveProcesses;
                return result;
            }
            created = true;
            result.CreateMs = timer.ElapsedMilliseconds;
            result.CreatedSuspended = true;
            result.MarkerBeforeResume = Has(dir, "middle-started");

            timer.Restart();
            bool assigned = mode != "uncontained-control" &&
                AssignProcessToJobObject(mode == "assign-failure" ? IntPtr.Zero : job, child.hProcess);
            result.Assigned = assigned;
            result.AssignMs = timer.ElapsedMilliseconds;
            if (!assigned && mode != "uncontained-control") {
                result.AssignError = Error();
                if (mode != "assign-failure") throw new InvalidOperationException("assign:win32=" + result.AssignError);
                Require(TerminateProcess(child.hProcess, 71), "terminate-own-suspended-process");
            } else if (mode == "resume-failure") {
                uint badResume = ResumeThread(IntPtr.Zero);
                result.ResumeError = Error();
                if (badResume != 0xffffffff) throw new InvalidOperationException("expected-resume-error");
                Require(TerminateJobObject(job, 72), "terminate-job-after-resume-error");
                result.OwnJobTerminated = true;
            } else {
                timer.Restart();
                uint previous = ResumeThread(child.hThread);
                result.ResumeMs = timer.ElapsedMilliseconds;
                if (previous == 0xffffffff) {
                    result.ResumeError = Error();
                    throw new InvalidOperationException("resume:win32=" + result.ResumeError);
                }
                result.Resumed = true;
                if (mode == "query-failure") {
                    BASIC_ACCOUNTING invalid;
                    // NULL consulta o job do processo atual, portanto não injeta erro
                    // neste host aninhado. O pseudo-handle de processo não é job.
                    result.QueryFailureObserved = !QueryInformationJobObject(new IntPtr(-1),
                        JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION, out invalid,
                        (uint)Marshal.SizeOf(typeof(BASIC_ACCOUNTING)), IntPtr.Zero);
                    result.QueryError = Error();
                }
                if (mode == "uncontained-control") {
                    result.ChildMarker = AwaitMarker(dir, "child-started", Deadline(3500));
                    Require(result.ChildMarker, "uncontained-child-did-not-start");
                    // Controle negativo: encerra só o handle do pai npm, sem
                    // escolher PID de shell/filho. Eles terminam naturalmente.
                    Require(TerminateProcess(child.hProcess, 76), "terminate-own-npm-only");
                    Require(AwaitMarker(dir, "middle-child-exit", Deadline(3500)),
                        "uncontained-descendants-did-not-finish");
                } else if (mode == "timeout" || mode == "termination-failure") {
                    result.ChildMarker = AwaitMarker(dir, "child-started", Deadline(3500));
                    result.ActiveBefore = (int)Accounting(job).ActiveProcesses;
                    if (mode == "termination-failure") {
                        result.TerminationFailureObserved = !TerminateJobObject(IntPtr.Zero, 73);
                        result.TerminationError = Error();
                    }
                    Require(TerminateJobObject(job, 74), "terminate-owned-job");
                    result.OwnJobTerminated = true;
                } else if (mode == "normal") {
                    uint waited = WaitForSingleObject(child.hProcess, 4500);
                    if (waited != WAIT_OBJECT_0) throw new InvalidOperationException("normal-parent-wait=" + waited);
                } else if (mode == "query-failure") {
                    Require(TerminateJobObject(job, 75), "terminate-job-after-query-error");
                    result.OwnJobTerminated = true;
                }
            }

            if (!AwaitEmpty(job, Deadline(2500))) throw new InvalidOperationException("job-not-empty");
            var accounting = Accounting(job);
            result.ActiveAfter = (int)accounting.ActiveProcesses;
            result.TotalAssociated = (int)accounting.TotalProcesses;
            result.MiddleMarker = Has(dir, "middle-started");
            result.ChildMarker = Has(dir, "child-started");
            if (mode == "timeout") {
                if (!AwaitMarker(dir, "control-marker", Deadline(2500))) throw new InvalidOperationException("control-did-not-run");
                result.ExternalControlMarker = true;
                // A ausência do marcador só vale junto com ActiveAfter=0.
                result.LateMarker = Has(dir, "child-late");
            } else {
                result.LateMarker = Has(dir, "child-late");
            }
        } catch (Exception error) {
            result.Failure = error.GetType().Name + ":" + error.Message;
        } finally {
            if (job != IntPtr.Zero) {
                // KILL_ON_JOB_CLOSE garante contenção até se a medição falhar.
                CloseHandle(job);
            }
            if (created) {
                CloseHandle(child.hThread);
                CloseHandle(child.hProcess);
            }
            if (external != null) {
                if (!external.HasExited) external.Kill();
                external.WaitForExit(1000);
                external.Dispose();
            }
            result.TotalMs = whole.ElapsedMilliseconds;
        }
        return result;
    }
}
