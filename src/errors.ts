// Messaggio leggibile da un errore, anche se arriva dal processo principale:
// Electron antepone "Error invoking remote method '…': Error: " al testo.
export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}
