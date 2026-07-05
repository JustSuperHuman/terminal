import { FormEvent, useEffect, useState } from "react";
import { AlertCircle, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { TerminalProject } from "@/lib/types";

interface ProjectTabsProps {
  projects: TerminalProject[];
  activeProjectId?: string;
  sessionCounts: Record<string, number>;
  onSelectProject: (projectId?: string) => void;
  onCreateProject: (name: string, cwd: string) => Promise<void>;
  onDeleteProject: (projectId: string) => Promise<void>;
}

const tabClass =
  "max-w-[200px] truncate rounded-md px-2.5 py-1 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function ProjectTabs({ projects, activeProjectId, sessionCounts, onSelectProject, onCreateProject, onDeleteProject }: ProjectTabsProps) {
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [createError, setCreateError] = useState("");
  const [confirmProject, setConfirmProject] = useState<TerminalProject | undefined>();
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (createOpen) {
      setName("");
      setCwd("");
      setSubmitting(false);
      setCreateError("");
    }
  }, [createOpen]);

  async function onSubmitCreate(event: FormEvent) {
    event.preventDefault();
    if (submitting) {
      return;
    }

    setSubmitting(true);
    setCreateError("");
    try {
      await onCreateProject(name, cwd);
      setCreateOpen(false);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  }

  async function onConfirmDelete() {
    if (!confirmProject || deleting) {
      return;
    }

    setDeleting(true);
    try {
      await onDeleteProject(confirmProject.id);
      setConfirmProject(undefined);
    } catch {
      // The error surfaces through the app-level action error banner.
      setConfirmProject(undefined);
    } finally {
      setDeleting(false);
    }
  }

  const confirmCount = confirmProject ? sessionCounts[confirmProject.id] ?? 0 : 0;

  return (
    <div className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b bg-background/95 px-2">
      <button
        type="button"
        onClick={() => onSelectProject(undefined)}
        className={cn(
          tabClass,
          !activeProjectId ? "bg-secondary font-medium text-secondary-foreground" : "text-muted-foreground hover:bg-secondary/60 hover:text-secondary-foreground"
        )}
      >
        All
      </button>

      {projects.map((project) => {
        const isActive = project.id === activeProjectId;
        return (
          <div
            key={project.id}
            className={cn(
              "group flex shrink-0 items-center rounded-md",
              isActive ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:bg-secondary/60 hover:text-secondary-foreground"
            )}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => onSelectProject(project.id)}
                  className={cn(tabClass, "rounded-r-none pr-1", isActive && "font-medium")}
                >
                  {project.name}
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-[360px] break-all font-mono text-xs">{project.cwd}</TooltipContent>
            </Tooltip>
            <button
              type="button"
              onClick={() => setConfirmProject(project)}
              className={cn(
                "mr-1 rounded p-0.5 transition-opacity hover:bg-background/60 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100"
              )}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="sr-only">Close project {project.name}</span>
            </button>
          </div>
        );
      })}

      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="iconSm" className="h-7 w-7 shrink-0" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            <span className="sr-only">New project</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>New project</TooltipContent>
      </Tooltip>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Project</DialogTitle>
          </DialogHeader>

          <form className="grid gap-4" onSubmit={onSubmitCreate}>
            <div className="grid gap-2">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="new-project-name">
                Name
              </label>
              <Input id="new-project-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="My Project" autoFocus />
            </div>

            <div className="grid gap-2">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="new-project-cwd">
                Directory
              </label>
              <Input
                id="new-project-cwd"
                value={cwd}
                onChange={(event) => setCwd(event.target.value)}
                placeholder="C:\path\to\project"
                className="font-mono"
              />
            </div>

            {createError ? (
              <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive-foreground">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0 break-words">{createError}</span>
              </div>
            ) : null}

            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={submitting || !name.trim() || !cwd.trim()} className="gap-2">
                <Plus className="h-4 w-4" aria-hidden="true" />
                Create
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(confirmProject)} onOpenChange={(open) => (!open ? setConfirmProject(undefined) : undefined)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Close Project</DialogTitle>
          </DialogHeader>

          <p className="text-sm text-muted-foreground">
            Close project '{confirmProject?.name}'? This stops {confirmCount} terminal{confirmCount === 1 ? "" : "s"} started in it.
          </p>

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => setConfirmProject(undefined)}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" disabled={deleting} onClick={() => void onConfirmDelete()}>
              Close Project
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
