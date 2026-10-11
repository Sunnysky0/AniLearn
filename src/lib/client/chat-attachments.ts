"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_CHAT_IMAGES, MAX_CHAT_IMAGE_BYTES } from "@/lib/types";
import { fileToJpegDataUrl } from "@/lib/client/media";

const IMAGE_QUALITIES = [0.82, 0.68, 0.54, 0.4];
const dataUrlBytes = (url: string) => {
  const data = url.split(",", 2)[1] ?? "";
  return data.length * 3 / 4 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
};

export function useChatAttachments() {
  const [images, setImages] = useState<string[]>([]);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState("");
  const imagesRef = useRef<string[]>([]);
  const pendingCount = useRef(0);
  const generation = useRef({ value: 0, invalid: false });
  const uploadQueue = useRef<Promise<void>>(Promise.resolve());
  const mounted = useRef(true);

  useEffect(() => {
    const life = { value: generation.current.value + 1, invalid: false };
    generation.current = life;
    uploadQueue.current = Promise.resolve();
    mounted.current = true;
    return () => {
      mounted.current = false;
      life.invalid = true;
    };
  }, []);

  const addFiles = useCallback(async (input: FileList | File[]) => {
    const files = Array.from(input).filter((file) => file.type.startsWith("image/"));
    if (!files.length) return;
    if (imagesRef.current.length + pendingCount.current + files.length > MAX_CHAT_IMAGES) {
      setError("每条消息最多附加 4 张图片。");
      return;
    }

    const currentLife = generation.current;
    const currentGeneration = currentLife.value;
    pendingCount.current += files.length;
    setProcessing(true);
    setError("");
    const previous = uploadQueue.current;
    let finishBatch: () => void = () => {};
    uploadQueue.current = new Promise<void>((resolve) => { finishBatch = resolve; });
    await previous;
    try {
      if (currentLife.invalid || generation.current !== currentLife || currentLife.value !== currentGeneration) return;
      const converted: string[] = [];
      for (const file of files) {
        let result = "";
        for (const quality of IMAGE_QUALITIES) {
          result = await fileToJpegDataUrl(file, 2000, quality);
          if (currentLife.invalid || generation.current !== currentLife || currentLife.value !== currentGeneration) return;
          if (dataUrlBytes(result) <= MAX_CHAT_IMAGE_BYTES) break;
        }
        if (dataUrlBytes(result) > MAX_CHAT_IMAGE_BYTES) {
          throw new Error("压缩后仍超过 2 MiB，请换一张较小的图片。");
        }
        converted.push(result);
      }
      if (!mounted.current || currentLife.invalid || generation.current !== currentLife || currentLife.value !== currentGeneration) return;
      imagesRef.current = [...imagesRef.current, ...converted];
      setImages(imagesRef.current);
    } catch (cause) {
      if (mounted.current && !currentLife.invalid && generation.current === currentLife && currentLife.value === currentGeneration) {
        setError(cause instanceof Error ? cause.message : "图片读取失败，请重试。");
      }
    } finally {
      finishBatch();
      if (mounted.current && !currentLife.invalid && generation.current === currentLife && currentLife.value === currentGeneration) {
        pendingCount.current = Math.max(0, pendingCount.current - files.length);
        setProcessing(pendingCount.current > 0);
      }
    }
  }, []);

  const removeImage = useCallback((index: number) => {
    imagesRef.current = imagesRef.current.filter((_, itemIndex) => itemIndex !== index);
    setImages(imagesRef.current);
  }, []);

  const clearImages = useCallback(() => {
    generation.current.value++;
    uploadQueue.current = Promise.resolve();
    pendingCount.current = 0;
    imagesRef.current = [];
    setImages([]);
    setProcessing(false);
    setError("");
  }, []);

  return { images, processing, error, addFiles, removeImage, clearImages, clearError: () => setError("") };
}
