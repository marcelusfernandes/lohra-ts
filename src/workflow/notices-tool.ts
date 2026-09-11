// Issue #402 (M8-6): the `workflow_notices`/`workflow_notices_ack` TOOL
// surface over `NoticesRepository` (issue #400, `src/state/notices-repository.ts`)
// — deliberately NOT in `tool.ts` (that module is `WorkflowTool`, the
// `run_workflow`/`workflow_status`/... family; notices is its own small
// surface, same reason `workflowAuditHandler` sits ALONGSIDE `WorkflowTool`
// in `tool.ts` rather than inside the class).
export function workflowNoticesHandler(): never {
  throw new Error("not implemented: workflowNoticesHandler");
}

export function workflowNoticesAckHandler(): never {
  throw new Error("not implemented: workflowNoticesAckHandler");
}
