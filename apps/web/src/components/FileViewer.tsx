import { Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog.tsx";

/**
 * A file's contents, over the thread.
 *
 * A real dialog rather than a floating card: it was hand-positioned before and
 * ended up cut off at the top of the window, which is exactly the arithmetic
 * a dialog primitive already does — plus the escape key and a focus trap.
 */
export function FileViewer({
  path,
  content,
  onClose,
}: {
  path: string;
  content: string | null;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="flex max-h-[80vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <DialogHeader className="shrink-0 border-b px-4 py-3">
          <DialogTitle className="font-mono text-[13px] font-medium">{path}</DialogTitle>
        </DialogHeader>
        {content === null ? (
          <p className="text-muted-foreground flex items-center gap-2 p-4 text-sm">
            <Loader2 className="size-3.5 animate-spin" /> loading…
          </p>
        ) : (
          <pre className="flex-1 overflow-auto p-4 font-mono text-[12.5px] leading-relaxed">
            {content}
          </pre>
        )}
      </DialogContent>
    </Dialog>
  );
}
