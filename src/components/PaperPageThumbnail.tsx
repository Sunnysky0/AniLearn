import { FileCode, FileText } from "lucide-react";
import { paperTextFormat } from "@/lib/paper-source";

export function PaperPageThumbnail({ src, mime, alt, className }: {
  src: string;
  mime?: string;
  alt: string;
  className?: string;
}) {
  const format = paperTextFormat(mime ?? "");
  if (format) {
    const Icon = format === "LaTeX" ? FileCode : FileText;
    return (
      <div className={`flex flex-col items-center justify-center gap-3 bg-neutral-50 p-4 text-neutral-600 ${className ?? ""}`}>
        <Icon className="h-8 w-8" />
        <span className="text-sm font-medium">{format}</span>
      </div>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} className={className} />;
}
