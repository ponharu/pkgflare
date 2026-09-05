export function logRegistryError(requestId: string, operation: string, error: unknown): void {
  console.error(
    JSON.stringify({
      level: "error",
      requestId,
      operation,
      errorType: error instanceof Error ? error.name : typeof error,
    }),
  );
}
