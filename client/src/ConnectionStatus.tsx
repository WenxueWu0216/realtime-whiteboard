import type { ConnectionStatus as Status } from "./useYjsRoom";

const LABEL: Record<Status, string> = {
  connecting: "连接中…",
  connected: "已连接",
  disconnected: "离线（本地编辑将在重连后自动合并）",
};

export function ConnectionStatus({ status, synced }: { status: Status; synced: boolean }) {
  const label = status === "connected" && !synced ? "同步中…" : LABEL[status];
  return (
    <div className={`status-badge status-${status}`}>
      <span className="dot" />
      {label}
    </div>
  );
}
