import * as Y from "yjs";

/**
 * Deterministic simulated editing session: `clients` independent Y.Docs make
 * random shape edits (add / move / recolor / delete), and their updates are
 * delivered to each other with random interleaving, exactly like several
 * browsers talking through the server. Returns every update in the order the
 * server would have received (and recorded) it.
 */
export function generateSession(opts: { ops: number; clients?: number; seed?: number }): Uint8Array[] {
  const clients = opts.clients ?? 4;
  let s = opts.seed ?? 1;
  const rand = () => {
    // mulberry32
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const docs = Array.from({ length: clients }, () => new Y.Doc());
  const out: Uint8Array[] = [];
  // Per-client inbox of updates not yet delivered (simulates network delay).
  const inbox: Uint8Array[][] = docs.map(() => []);

  for (let i = 0; i < opts.ops; i++) {
    const c = Math.floor(rand() * clients);
    const doc = docs[c];
    // Deliver some pending remote updates first (random lag).
    const deliver = Math.floor(rand() * (inbox[c].length + 1));
    for (const u of inbox[c].splice(0, deliver)) Y.applyUpdate(doc, u, "remote");

    const shapes = doc.getMap<Record<string, unknown>>("shapes");
    const ids = Array.from(shapes.keys());
    let update: Uint8Array | null = null;
    const capture = (u: Uint8Array, origin: unknown) => {
      if (origin !== "remote") update = u;
    };
    doc.on("update", capture);
    const r = rand();
    if (ids.length === 0 || r < 0.25) {
      const id = `s${c}-${i}`;
      shapes.set(id, { id, type: "rect", x: Math.round(rand() * 1000), y: Math.round(rand() * 800), fill: "#f97316" });
    } else if (r < 0.85) {
      const id = ids[Math.floor(rand() * ids.length)];
      const cur = shapes.get(id)!;
      shapes.set(id, { ...cur, x: Math.round(rand() * 1000), y: Math.round(rand() * 800) });
    } else if (r < 0.95) {
      const id = ids[Math.floor(rand() * ids.length)];
      shapes.set(id, { ...shapes.get(id)!, fill: rand() < 0.5 ? "#3b82f6" : "#22c55e" });
    } else {
      shapes.delete(ids[Math.floor(rand() * ids.length)]);
    }
    doc.off("update", capture);
    if (update) {
      out.push(update);
      for (let j = 0; j < clients; j++) if (j !== c) inbox[j].push(update);
    }
  }
  docs.forEach((d) => d.destroy());
  return out;
}

/** Ground truth: apply ops[0..k) to a fresh doc, one by one. */
export function replayAll(ops: Uint8Array[], k: number): Y.Doc {
  const doc = new Y.Doc();
  for (let i = 0; i < k; i++) Y.applyUpdate(doc, ops[i]);
  return doc;
}

/** Comparable representation of a doc's state. */
export function fingerprint(doc: Y.Doc): { shapes: unknown; sv: string } {
  return {
    shapes: doc.getMap("shapes").toJSON(),
    sv: Buffer.from(Y.encodeStateVector(doc)).toString("base64"),
  };
}
