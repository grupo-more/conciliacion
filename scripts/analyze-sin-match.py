"""
Cruza los movimientos de cartola SIN match (dump/sin_match_*.csv) contra los
feeds de API (dump/db_dump_*.json: tesoreria Dynatech + egresoMovement) para
detectar pares que el motor pasó por alto.

Señal fuerte de "match pasado por alto":
  movimiento de cartola sin match  +  movimiento de API sin linkear (linkCount=0)
  con el MISMO monto exacto y fecha cercana (|dif dias| <= WINDOW).

Lados:
  IN  (abono, monto>0)  -> tesoreria tipoOperacion=INGRESO (monto>0)
  OUT (cargo, monto<0)  -> egresoMovement  +  tesoreria tipoOperacion=EGRESO

Segmenta aparte:
  - uso parcial (esUsoParcial=1): flujo de traspasos internos, no Dynatech.
  - Transbank (esTransbankAbono=1): flujo propio (Cruce Transbank).

Uso:
  python scripts/analyze-sin-match.py
Salida:
  dump/sin_match_candidatos_<fecha>.csv
"""
import json, csv, collections, sys, os
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
DUMP = os.path.join(HERE, "..", "dump")
CSV_IN = None
JSON_IN = None
for f in os.listdir(DUMP):
    if f.startswith("sin_match_2") and f.endswith(".csv"):
        CSV_IN = os.path.join(DUMP, f)
    if f.startswith("db_dump_") and f.endswith(".json"):
        JSON_IN = os.path.join(DUMP, f)

WINDOW = 7  # dias de tolerancia

def parse_date(s):
    # admite "2026-06-22" o ISO "2026-06-22T15:35:52.000Z"
    return datetime.fromisoformat(s.replace("Z", "+00:00")).date()

def bank_token(banco):
    """tesoreria.banco -> bankCode de la cartola."""
    if not banco:
        return None
    b = banco.lower()
    if "bci" in b: return "BCI"
    if "santander" in b: return "SANTANDER"
    if "internacional" in b: return "INTERNACIONAL"
    if "chile" in b: return "CHILE"
    return None

def main():
    rows = list(csv.DictReader(open(CSV_IN, encoding="utf-8-sig")))
    data = json.load(open(JSON_IN, encoding="utf-8"))

    # ---- API: tesoreria (con estado de link via matches) ----
    # matches[].linkCount nos dice si la tesoreria ya esta vinculada a un banco.
    link_by_tesid = {m["tesoreria"]["id"]: m for m in data["matches"]}
    tes = []
    for t in data["raw"]["tesoreria"]:
        m = link_by_tesid.get(t["id"], {})
        tes.append({
            "id": t["id"],
            "externalId": t.get("externalId"),
            "monto": int(t["monto"]),
            "tipoOp": t["tipoOperacion"],
            "banco": t.get("banco"),
            "bankCode": bank_token(t.get("banco")),
            "fecha": parse_date(t["fecha"]),
            "glosa": (t.get("glosa") or "")[:60],
            "estado": t.get("estadoActual"),
            "linkCount": m.get("linkCount", 0),
            "status": m.get("status"),
        })
    # egresoMovement (no trae estado de link en el dump -> lo tratamos como candidato libre)
    egr = []
    for e in data["raw"]["egresoMovement"]:
        egr.append({
            "id": e["id"],
            "externalId": e.get("externalId"),
            "monto": int(e["monto"]),          # negativo
            "fecha": parse_date(e["fecha"]),
            "glosa": (e.get("glosa") or "")[:60],
            "rubro": e.get("rubroNombre"),
        })

    # indices por |monto|
    tes_in = collections.defaultdict(list)   # INGRESO
    tes_out = collections.defaultdict(list)  # EGRESO
    for t in tes:
        if t["tipoOp"] == "INGRESO":
            tes_in[abs(t["monto"])].append(t)
        elif t["tipoOp"] == "EGRESO":
            tes_out[abs(t["monto"])].append(t)
    egr_by_amt = collections.defaultdict(list)
    for e in egr:
        egr_by_amt[abs(e["monto"])].append(e)

    out_rows = []
    stats = collections.Counter()

    for r in rows:
        amt = abs(int(r["amount"]))
        d = parse_date(r["postDate"])
        direction = r["direction"]
        usoParcial = r["esUsoParcial"] == "1"
        tbk = r["esTransbankAbono"] == "1"

        if usoParcial:
            stats["bank_usoParcial"] += 1
            continue
        if tbk:
            stats["bank_transbank"] += 1
            continue

        stats[f"bank_{direction}_core"] += 1

        # candidatos por monto exacto y ventana de fecha
        cands = []
        if direction == "IN":
            for t in tes_in.get(amt, []):
                dd = abs((t["fecha"] - d).days)
                if dd <= WINDOW:
                    cands.append(("tesoreria", t, dd))
        else:  # OUT
            for t in tes_out.get(amt, []):
                dd = abs((t["fecha"] - d).days)
                if dd <= WINDOW:
                    cands.append(("tesoreria-EGRESO", t, dd))
            for e in egr_by_amt.get(amt, []):
                dd = abs((e["fecha"] - d).days)
                if dd <= WINDOW:
                    cands.append(("egreso", e, dd))

        if not cands:
            stats[f"bank_{direction}_sin_candidato"] += 1
            continue

        # ordenar: primero candidatos LIBRES (linkCount 0 / egreso), luego por dia mas cercano
        def free(c):
            return c[1].get("linkCount", 0) == 0
        cands.sort(key=lambda c: (0 if free(c) else 1, c[2]))
        top = cands[0]
        free_cands = [c for c in cands if free(c)]
        # filtro banco para IN/tesoreria (reduce coincidencias de monto redondo)
        banco_ok = True
        if top[0].startswith("tesoreria") and top[1].get("bankCode"):
            banco_ok = top[1]["bankCode"] == r["bankCode"]

        kind = "LIBRE" if free_cands else "YA_LINKEADO"
        stats[f"bank_{direction}_con_candidato_{kind}"] += 1
        if free_cands and banco_ok:
            stats[f"bank_{direction}_OVERLOOKED"] += 1

        src, api, dd = top
        out_rows.append({
            "bank_id": r["id"],
            "direction": direction,
            "bankCode": r["bankCode"],
            "holder": r["holderName"],
            "postDate": r["postDate"],
            "amount": r["amount"],
            "glosa_banco": r["description"][:60],
            "contraparte": r["counterpartyName"],
            "n_candidatos": len(cands),
            "n_libres": len(free_cands),
            "match_kind": kind,
            "banco_ok": "1" if banco_ok else "0",
            "api_src": src,
            "api_id": api["id"],
            "api_externalId": api.get("externalId"),
            "api_fecha": str(api["fecha"]),
            "dia_dif": dd,
            "api_banco": api.get("banco", ""),
            "api_glosa": api.get("glosa", ""),
            "api_estado_consolidado": api.get("status", ""),
            "api_linkCount": api.get("linkCount", ""),
        })

    # ---- salida ----
    today = datetime.now().strftime("%Y-%m-%d") if "--today" not in sys.argv else ""
    out_path = os.path.join(DUMP, "sin_match_candidatos.csv")
    cols = list(out_rows[0].keys()) if out_rows else []
    with open(out_path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        # primero los OVERLOOKED libres y banco_ok
        out_rows.sort(key=lambda x: (0 if (x["match_kind"]=="LIBRE" and x["banco_ok"]=="1") else 1, x["dia_dif"]))
        w.writerows(out_rows)

    print("=" * 64)
    print("ANALISIS SIN MATCH  vs  API (Dynatech tesoreria + egresos)")
    print("=" * 64)
    print(f"CSV cartola:  {os.path.basename(CSV_IN)}  ({len(rows)} filas)")
    print(f"JSON API:     {os.path.basename(JSON_IN)}")
    print(f"Ventana fecha: +-{WINDOW} dias  |  monto exacto")
    print()
    for k in sorted(stats):
        print(f"  {k:42s} {stats[k]}")
    print()
    print(f"Filas con candidato API escritas: {len(out_rows)}")
    print(f"Archivo: {out_path}")
    print()
    print("Leé primero las filas match_kind=LIBRE y banco_ok=1: cartola sin match")
    print("con un movimiento de API sin linkear, mismo monto y fecha cercana =")
    print("candidato fuerte a conciliacion pasada por alto.")

if __name__ == "__main__":
    main()
