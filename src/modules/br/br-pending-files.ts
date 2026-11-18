// Replay files picked on the landing page. Files cannot go in the URL, so they wait
// here in memory until /br takes them.
let pendingFiles: File[] = [];

export function setBrPendingFiles(files: File[]) {
  pendingFiles = files;
}

export function takeBrPendingFiles() {
  const files = pendingFiles;
  pendingFiles = [];
  return files;
}
