/**
 * Hook de instrumentacion de Next (corre una vez al arrancar el server).
 * Lo usamos para levantar el scheduler de sincronizacion en segundo plano.
 *
 * Solo en runtime Node (no en edge ni build). Habilitado via
 * experimental.instrumentationHook en next.config.js.
 */
export async function register() {
  // El import condicional dentro de este if es lo que hace que el bundler de
  // Next NO incluya el scheduler (ni sus deps node-only como crypto) en el
  // bundle edge. No cambiar a early-return: rompe ese tree-shaking.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startSyncScheduler } = await import("@/lib/sync/scheduler");
    startSyncScheduler();
  }
}
