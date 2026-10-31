import { useEffect, useMemo, useRef, useState } from "react";
import { Whiteboard } from "../Whiteboard";
import { ReplayPlayer, type PlayerState } from "./ReplayPlayer";

const SPEEDS = [1, 2, 4];

function fmt(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Read-only replay of a board's recorded session: play/pause, 1x/2x/4x,
 * a scrubber to seek anywhere (snapshot + ops, never from the start), and a
 * jump-to-live button. The debug overlay shows which snapshot each seek used.
 */
export function ReplayView({ room, onJumpToLive }: { room: string; onJumpToLive: () => void }) {
  const player = useMemo(() => new ReplayPlayer(room), [room]);
  const [s, setS] = useState<PlayerState>(player.state);
  const [scrub, setScrub] = useState<number | null>(null);
  const [showDebug, setShowDebug] = useState(true);
  const scrubTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const unsub = player.subscribe(setS);
    void player.init();
    // Keep the scrubber's end in sync with the live board while viewing.
    const poll = setInterval(() => void player.refreshTimeline().catch(() => {}), 5000);
    return () => {
      clearInterval(poll);
      unsub();
      player.destroy();
    };
  }, [player]);

  const tl = s.timeline;
  const start = tl?.startTs ?? null;
  const duration = start !== null && tl?.headTs ? tl.headTs - start : 0;
  const pos = scrub ?? (start !== null && s.ts !== null ? s.ts - start : 0);

  const onScrub = (value: number) => {
    setScrub(value);
    // Debounce seeks while dragging; each seek is snapshot + a bounded number of ops.
    if (scrubTimer.current) clearTimeout(scrubTimer.current);
    scrubTimer.current = setTimeout(() => {
      void player.seek({ atMs: value }).finally(() => setScrub(null));
    }, 120);
  };

  const empty = tl !== null && tl.headSeq === 0;

  return (
    <div className="replay">
      <div className="replay-controls">
        <button className="primary" disabled={empty} onClick={() => (s.playing ? player.pause() : player.play())}>
          {s.playing ? "Pause" : "Play"}
        </button>
        <div className="speed-group">
          {SPEEDS.map((sp) => (
            <button key={sp} className={s.speed === sp ? "active" : ""} onClick={() => player.setSpeed(sp)}>
              {sp}x
            </button>
          ))}
        </div>
        <span className="time">
          {fmt(pos)} / {fmt(duration)}
        </span>
        <div className="scrubber">
          <input
            type="range"
            min={0}
            max={Math.max(duration, 1)}
            step={1}
            value={Math.min(pos, Math.max(duration, 1))}
            disabled={empty}
            onChange={(e) => onScrub(Number(e.target.value))}
            aria-label="Seek"
          />
          <div className="snapshot-ticks" aria-hidden>
            {start !== null &&
              duration > 0 &&
              tl?.snapshots.map((snap) => (
                <span key={snap.seq} style={{ left: `${((snap.ts - start) / duration) * 100}%` }} title={`snapshot @ seq ${snap.seq}`} />
              ))}
          </div>
        </div>
        <button onClick={onJumpToLive}>Jump to live</button>
        <label className="debug-toggle">
          <input type="checkbox" checked={showDebug} onChange={(e) => setShowDebug(e.target.checked)} /> debug
        </label>
      </div>

      <main className="canvas-wrap">
        <Whiteboard shapes={s.shapes} readOnly />
        {empty && <div className="replay-empty">No recorded operations for this board yet.</div>}
        {showDebug && (
          <div className="debug-overlay">
            <div>
              seq <b>{s.seq}</b> / {tl?.headSeq ?? "?"} {s.loading && "· loading…"}
            </div>
            {s.debug && (
              <>
                <div>
                  last seek: <b>{s.debug.strategy}</b> → seq {s.debug.target} in {s.debug.ms.toFixed(1)} ms
                </div>
                <div>
                  snapshot used:{" "}
                  {s.debug.snapshotSeq !== null ? (
                    <>
                      <b>seq {s.debug.snapshotSeq}</b> <code>{s.debug.snapshotKey}</code>
                    </>
                  ) : (
                    "none"
                  )}
                </div>
                <div>
                  ops applied after snapshot: <b>{s.debug.opsApplied}</b> · segments fetched: {s.debug.segmentsFetched}
                </div>
              </>
            )}
            <div>
              snapshots: {tl?.snapshots.length ?? 0} · flushed to S3 through seq {tl?.flushedSeq ?? 0}
            </div>
            {s.error && <div className="debug-error">{s.error}</div>}
          </div>
        )}
      </main>
    </div>
  );
}
