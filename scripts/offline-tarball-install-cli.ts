import { prepareOfflineTarballConsumer } from "./offline-tarball-install.js";

const [project, consumer, tarball] = process.argv.slice(2);
if (project === undefined || consumer === undefined || tarball === undefined) {
  throw new Error("OFFLINE_TARBALL_INSTALL_USAGE");
}
prepareOfflineTarballConsumer({ project, consumer, tarball });
