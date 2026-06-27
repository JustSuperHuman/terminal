import { FormEvent, useEffect, useMemo, useState } from "react";
import { AlertCircle, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { CreateSessionOptions, TerminalProfile, TerminalSessionSummary } from "@/lib/types";

interface NewTerminalDialogProps {
  open: boolean;
  profiles: TerminalProfile[];
  onOpenChange: (open: boolean) => void;
  onCreate: (options: CreateSessionOptions) => Promise<TerminalSessionSummary>;
}

function splitArgs(value: string): string[] | undefined {
  const args = value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
  return args.length > 0 ? args : undefined;
}

function shellName(value: string) {
  return value.split(/[\\/]/).pop() ?? value;
}

export function NewTerminalDialog({ open, profiles, onOpenChange, onCreate }: NewTerminalDialogProps) {
  const defaultProfile = profiles[0];
  const [profileId, setProfileId] = useState("");
  const [title, setTitle] = useState("");
  const [shell, setShell] = useState("");
  const [args, setArgs] = useState("");
  const [cwd, setCwd] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const selectedProfile = useMemo(() => profiles.find((profile) => profile.id === profileId) ?? defaultProfile, [defaultProfile, profileId, profiles]);

  useEffect(() => {
    if (open) {
      setProfileId(defaultProfile?.id ?? "");
      setTitle("");
      setShell("");
      setArgs("");
      setCwd("");
      setSubmitting(false);
      setError("");
    }
  }, [defaultProfile?.id, open]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting) {
      return;
    }

    const customShell = shell.trim();
    const nextTitle = title.trim() || (customShell ? shellName(customShell) : undefined);
    const options: CreateSessionOptions = {
      title: nextTitle,
      cwd: cwd.trim() || undefined,
      ...(customShell
        ? {
            shell: customShell,
            args: splitArgs(args)
          }
        : {
            profileId: selectedProfile?.id
          })
    };

    setSubmitting(true);
    setError("");
    try {
      await onCreate(options);
      onOpenChange(false);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Terminal</DialogTitle>
        </DialogHeader>

        <form className="grid gap-4" onSubmit={onSubmit}>
          <div className="grid gap-2">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="new-terminal-profile">
              Profile
            </label>
            <select
              id="new-terminal-profile"
              value={profileId}
              onChange={(event) => setProfileId(event.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.label}
                </option>
              ))}
            </select>
          </div>

          <div className="grid gap-2">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="new-terminal-title">
              Title
            </label>
            <Input id="new-terminal-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder={selectedProfile?.label ?? "Terminal"} />
          </div>

          <div className="grid gap-2">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="new-terminal-shell">
              Shell
            </label>
            <Input id="new-terminal-shell" value={shell} onChange={(event) => setShell(event.target.value)} placeholder={selectedProfile?.shell ?? "pwsh"} />
          </div>

          <div className="grid gap-2">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="new-terminal-args">
              Arguments
            </label>
            <Textarea
              id="new-terminal-args"
              value={args}
              onChange={(event) => setArgs(event.target.value)}
              rows={3}
              className="resize-none font-mono text-xs"
              placeholder={selectedProfile?.args.join("\n") ?? "-NoLogo"}
            />
          </div>

          <div className="grid gap-2">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="new-terminal-cwd">
              Working Directory
            </label>
            <Input id="new-terminal-cwd" value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="Current host directory" />
          </div>

          {error ? (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive-foreground">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0 break-words">{error}</span>
            </div>
          ) : null}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || (!selectedProfile && !shell.trim())} className={cn("gap-2")}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              Create
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
