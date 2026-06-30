/**
 * Scheduler de sincronizacion en segundo plano.
 *
 * Corre dentro del proceso del servidor (PM2 fork, 1 instancia) y sincroniza
 * periodicamente las 3 fuentes externas — Dynatech (Tesoreria), TBK y Egresos —
 * DESACOPLADO de la navegacion. Asi los modulos del front solo leen de la BD
 * (instantaneo) y nunca disparan ni esperan a la API externa.
 *
 * Se arranca una sola vez desde src/instrumentation.ts (hook register() de
 * Next). El guard sobre globalThis evita doble-arranque en hot-reload de dev.
 *
 * Garantias:
 *   - Idempotente: si ya esta corriendo, startSyncScheduler() no hace nada.
 *   - Anti-solapamiento: cada fuente tiene su flag; si una corrida tarda mas
 *     que el intervalo, la siguiente se saltea (no se encolan).
 *   - Tolerante a errores: un fallo de una fuente se loguea y no frena al resto
 *     ni mata el proceso.
 */

// Intervalo entre corridas (configurable por env). Default 2 min.
const INTERVAL_MS = Number(process.env.SYNC_SCHEDULER_INTERVAL_MS) || 120_000;
// Pequeño desfase entre fuentes para no pegarle a las 3 APIs al mismo tiempo.
const STAGGER_MS = 5_000;

type Runner = { name: string; run: () => Promise<unknown>; running: boolean };

const g = globalThis as unknown as {
  __syncSchedulerStarted?: boolean;
  __syncSchedulerTimers?: ReturnType<typeof setInterval>[];
};

async function tick(r: Runner) {
  if (r.running) {
    console.warn(`[sync-scheduler] ${r.name}: corrida anterior aun en curso, salteando.`);
    return;
  }
  r.running = true;
  const t0 = Date.now();
  try {
    await r.run();
    console.log(`[sync-scheduler] ${r.name}: ok en ${Date.now() - t0}ms`);
  } catch (e) {
    console.error(
      `[sync-scheduler] ${r.name}: error`,
      e instanceof Error ? e.message : e,
    );
  } finally {
    r.running = false;
  }
}

export function startSyncScheduler() {
  if (g.__syncSchedulerStarted) return;
  g.__syncSchedulerStarted = true;
  g.__syncSchedulerTimers = [];

  console.log(`[sync-scheduler] arrancando (cada ${Math.round(INTERVAL_MS / 1000)}s)`);

  // Import diferido: estos modulos tocan Prisma/fetch y solo deben cargarse en
  // runtime Node (no en build ni edge). El register() ya garantiza nodejs.
  void (async () => {
    const [
      { runTesoreriaSync },
      { runTbkTesoreriaSync },
      { runEgresosSync },
      { runMovimientosSync },
      { runMatchMovimientos },
    ] = await Promise.all([
      import("@/lib/tesoreria/sync"),
      import("@/lib/transbank/sync-tbk"),
      import("@/lib/egresos/sync-egresos"),
      import("@/lib/movimientos/sync-movimientos"),
      import("@/lib/movimientos/match-movimientos"),
    ]);

    const runners: Runner[] = [
      { name: "tesoreria", run: runTesoreriaSync, running: false },
      { name: "tbk", run: runTbkTesoreriaSync, running: false },
      { name: "egresos", run: runEgresosSync, running: false },
      // Movimientos de caja: ingiere CAJA_BANCO/BANCO_BANCO y los cruza contra
      // la cartola en la misma corrida.
      {
        name: "movimientos",
        run: async () => {
          await runMovimientosSync();
          return runMatchMovimientos();
        },
        running: false,
      },
    ];

    runners.forEach((r, i) => {
      // Stagger inicial + intervalo periodico para cada fuente.
      const startDelay = i * STAGGER_MS;
      setTimeout(() => {
        void tick(r);
        const timer = setInterval(() => void tick(r), INTERVAL_MS);
        g.__syncSchedulerTimers!.push(timer);
      }, startDelay);
    });
  })();
}
