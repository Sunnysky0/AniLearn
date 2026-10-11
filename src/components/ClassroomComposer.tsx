"use client";

import Image from "next/image";
import { Image as ImageIcon, Lightbulb, Paperclip, Send, Square, X } from "lucide-react";
import { useRef, useState } from "react";
import { MAX_CHAT_IMAGES, MAX_CHAT_TEXT_CHARS } from "@/lib/types";

export interface ComposerAction {
  label: string;
  onSelect: () => void;
}

export function ClassroomComposer(props: {
  value: string;
  onValueChange: (value: string) => void;
  images: string[];
  onRemoveImage: (index: number) => void;
  onAddImages: (files: FileList | File[]) => void;
  imageProcessing: boolean;
  attachmentError?: string;
  onClearAttachmentError?: () => void;
  canSend: boolean;
  busy: boolean;
  placeholder?: string;
  quickActions: ComposerAction[];
  onHint: () => void;
  onSend: (text: string, images: string[]) => void;
  onStop: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [lengthError, setLengthError] = useState("");
  const imageLimitReached = props.images.length >= MAX_CHAT_IMAGES;

  function send() {
    if (!props.canSend || props.imageProcessing) return;
    const text = props.value.trim();
    if (Array.from(text).length > MAX_CHAT_TEXT_CHARS) {
      setLengthError("单条文字最多 4000 字，请分成几条消息发送。");
      return;
    }
    setLengthError("");
    if (!text && !props.images.length) return;
    props.onSend(text, props.images);
  }

  return (
    <div className="shrink-0 border-t border-neutral-200/60 bg-white/70 p-3">
      {(props.attachmentError || lengthError) && (
        <div role="alert" className="mb-2 flex items-center gap-2 bg-neutral-100 px-3 py-1.5 text-[11px] text-neutral-800">
          <span className="flex-1">{props.attachmentError || lengthError}</span>
          <button type="button" aria-label="关闭提示" onClick={() => { setLengthError(""); props.onClearAttachmentError?.(); }}>
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      <div className="thin-scroll mb-2 flex gap-1.5 overflow-x-auto pb-0.5">
        {props.quickActions.map((action) => (
          <button key={action.label} type="button" onClick={action.onSelect}
            disabled={!props.canSend || props.imageProcessing}
            className="shrink-0 border border-neutral-200 bg-white px-3 py-1 text-xs text-neutral-600 transition hover:border-neutral-300 hover:bg-neutral-100 hover:text-neutral-800 disabled:cursor-not-allowed disabled:opacity-40">
            {action.label}
          </button>
        ))}
        {props.busy && (
          <button type="button" onClick={props.onStop}
            className="ml-auto inline-flex shrink-0 items-center gap-1 bg-neutral-100 px-3 py-1 text-xs text-neutral-500 hover:text-neutral-800">
            <Square className="h-3 w-3" />停止讲解
          </button>
        )}
      </div>
      <div className="border border-neutral-200 bg-white p-2 transition">
        {props.images.length > 0 && (
          <div className="flex flex-wrap gap-2 px-1 pb-2">
            {props.images.map((src, index) => (
              <div key={index} className="relative">
                <Image src={src} width={64} height={64} unoptimized alt={"待发送图片 " + (index + 1)}
                  className="h-16 w-16 border border-neutral-200 object-cover" />
                <button type="button" aria-label={"移除图片 " + (index + 1)} onClick={() => props.onRemoveImage(index)}
                  className="absolute -right-1.5 -top-1.5 bg-neutral-700 p-0.5 text-white">
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          aria-label="课堂消息"
          value={props.value}
          maxLength={MAX_CHAT_TEXT_CHARS * 2}
          onChange={(event) => { setLengthError(""); props.onValueChange(event.target.value); }}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
            if (!files.length) {
              for (const item of Array.from(event.clipboardData.items)) {
                if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
                const file = item.getAsFile();
                if (file) files.push(file);
              }
            }
            if (!files.length) return;
            if (!event.clipboardData.getData("text/plain")) event.preventDefault();
            props.onAddImages(files);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
              event.preventDefault();
              send();
            }
          }}
          rows={2}
          placeholder={props.placeholder || "输入你的问题，或发送“继续讲解”…"}
          className="w-full resize-none bg-transparent px-2 py-1 text-sm text-neutral-700 outline-none placeholder:text-neutral-500"
        />
        <div className="flex items-center gap-1 px-1">
          <button type="button" onClick={() => fileRef.current?.click()} disabled={imageLimitReached || props.imageProcessing}
            className="p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 disabled:opacity-40" title="上传解题草稿图片" aria-label="上传解题草稿图片">
            <Paperclip className="h-5 w-5" />
          </button>
          <button type="button" onClick={() => cameraRef.current?.click()} disabled={imageLimitReached || props.imageProcessing}
            className="p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 disabled:opacity-40" title="拍照上传" aria-label="拍照上传">
            <ImageIcon className="h-5 w-5" />
          </button>
          <button type="button" onClick={props.onHint} disabled={!props.canSend || props.imageProcessing} className="p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 disabled:opacity-40" title="请求提示" aria-label="请求提示">
            <Lightbulb className="h-5 w-5" />
          </button>
          <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(event) => {
            if (event.target.files) props.onAddImages(event.target.files);
            event.currentTarget.value = "";
          }} />
          <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={(event) => {
            if (event.target.files) props.onAddImages(event.target.files);
            event.currentTarget.value = "";
          }} />
          {props.imageProcessing && <span role="status" className="text-[11px] text-neutral-500">处理图片…</span>}
          <button type="button" onClick={send} disabled={!props.canSend || props.imageProcessing || (!props.value.trim() && !props.images.length)}
            title="发送消息" aria-label="发送消息"
            className="ml-auto flex h-10 w-10 items-center justify-center bg-neutral-900 text-white transition hover:brightness-110 disabled:opacity-40">
            <Send className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
