// Readable message from an error, even when it comes from the main process:
// Electron prefixes the text with "Error invoking remote method '…': Error: ".
export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}
