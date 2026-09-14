import { useCallback } from "react";
import { useDropzone } from "react-dropzone";

interface Props {
  title: string;
  hint: string;
  accept: Record<string, string[]>;
  fileName: string | null;
  onFile: (name: string, bytes: Uint8Array) => void;
  /** área maior (tela principal) vs compacta (onboarding). */
  size?: "lg" | "sm";
}

export function Dropzone({ title, hint, accept, fileName, onFile, size = "sm" }: Props) {
  const onDrop = useCallback(
    (files: File[]) => {
      const f = files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => onFile(f.name, new Uint8Array(reader.result as ArrayBuffer));
      reader.readAsArrayBuffer(f);
    },
    [onFile],
  );
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept,
    multiple: false,
  });

  return (
    <div
      {...getRootProps()}
      className={`group cursor-pointer rounded-card border-2 border-dashed text-center transition-colors focus-visible:outline-none ${
        size === "lg" ? "px-8 py-12" : "px-6 py-7"
      } ${
        isDragActive
          ? "border-cofre bg-cofre-soft"
          : fileName
            ? "border-entrada/50 bg-entrada-soft/50"
            : "border-line bg-surface-muted/50 hover:border-cofre hover:bg-cofre-soft/50"
      }`}
    >
      <input {...getInputProps()} />
      <div
        className={`mx-auto mb-3 grid place-items-center rounded-card ${
          size === "lg" ? "h-12 w-12" : "h-10 w-10"
        } ${fileName ? "bg-entrada text-white" : "bg-cofre text-white"}`}
        aria-hidden
      >
        {fileName ? <CheckIcon /> : <UploadIcon />}
      </div>
      <div className="font-display text-sm font-semibold text-ink">{title}</div>
      <div className="mt-1 text-xs text-ink-soft">{hint}</div>
      {fileName && (
        <div className="mt-3 inline-flex max-w-full items-center gap-1.5 rounded-pill bg-entrada-soft px-3 py-1 text-xs font-medium text-entrada">
          <span aria-hidden>✓</span>
          <span className="truncate">{fileName}</span>
        </div>
      )}
    </div>
  );
}

function UploadIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 16V4M12 4l-4 4M12 4l4 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}
function CheckIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
