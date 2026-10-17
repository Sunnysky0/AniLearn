"use client";

import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { MessageSquare, PanelRightClose, X } from "lucide-react";
import styles from "./reader.module.css";

export default function ReadingWorkspace({ children, tutor, initialOpen = false, open, onOpenChange, showToggle = true }: {
  children: ReactNode; tutor: ReactNode; initialOpen?: boolean; open?: boolean; onOpenChange?: (open: boolean) => void; showToggle?: boolean;
}) {
  const [localOpen, setLocalOpen] = useState(initialOpen);
  const [width, setWidth] = useState(380);
  const workspace = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const visible = open ?? localOpen;
  function toggle(value: boolean) { setLocalOpen(value); onOpenChange?.(value); }
  return <div ref={workspace} className={`${styles.workspace} ${visible ? styles.workspaceOpen : ""}`} style={{ "--tutor-width": `${width}px` } as CSSProperties}>
    <main className={styles.workspaceReading}>{children}</main>
    {showToggle && <button className={styles.tutorToggle} aria-label={visible ? "收起导师" : "打开导师"} aria-expanded={visible} aria-controls="reading-tutor-panel" onClick={() => toggle(!visible)}>{visible ? <PanelRightClose size={17} /> : <MessageSquare size={17} />}<span>{visible ? "收起导师" : "导师"}</span></button>}
    {visible && <button className={styles.mobileBackdrop} aria-label="关闭导师面板" onClick={() => toggle(false)} />}
    <aside id="reading-tutor-panel" className={styles.workspaceTutor} aria-label="阅读导师" hidden={!visible}>
      <div className={styles.resizeGrip} role="separator" aria-label="调整导师面板宽度" aria-orientation="vertical" aria-valuemin={280} aria-valuemax={720} aria-valuenow={width} tabIndex={0}
        onPointerDown={event => { dragging.current = true; event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); }}
        onPointerMove={event => { if (!dragging.current || !workspace.current) return; const bounds = workspace.current.getBoundingClientRect(); setWidth(Math.max(280, Math.min(720, bounds.width * .55, event.clientX - bounds.left))); }}
        onPointerUp={event => { dragging.current = false; event.currentTarget.releasePointerCapture(event.pointerId); }}
        onPointerCancel={() => { dragging.current = false; }}
        onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); setWidth(value => Math.max(280, Math.min(720, value + (event.key === "ArrowLeft" ? -20 : 20)))); } }} />
      <div className={styles.tutorPanelHeader}><span>阅读导师</span><button aria-label="关闭导师面板" onClick={() => toggle(false)}><X size={17} /></button></div>
      <div className={styles.tutorPanelBody}>{tutor}</div>
    </aside>
  </div>;
}
