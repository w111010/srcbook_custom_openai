import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createSession, disk, exportSrcmdFile, importSrcbook } from '@/lib/server';
import { getTitleForSession } from '@/lib/utils';
import type { FsObjectResultType, FsObjectType, SessionType } from '@/types';
import { ExportLocationPicker, FilePicker } from '@/components/file-picker';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import useEffectOnce from './use-effect-once';

export function ImportSrcbookModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const [fsResult, setFsResult] = useState<FsObjectResultType>({ dirname: '', entries: [] });
  const [error, setError] = useState<string | null>(null);

  const navigate = useNavigate();

  useEffectOnce(() => {
    void (async () => {
      const response = await disk();
      setFsResult(response.result);
    })();
  });

  async function onChange(entry: FsObjectType): Promise<void> {
    setError(null);

    if (entry.basename.length > 44) {
      setError('Srcbook title should be less than 44 characters');
      return;
    }

    const { error: importError, result: importResult } = await importSrcbook({ path: entry.path });

    if (importError) {
      setError('There was an error while importing this srcbook.');
      return;
    }

    const { error, result } = await createSession({ path: importResult.dir });

    if (error) {
      setError('There was an error while importing this srcbook.');
      return;
    }

    navigate(`/srcbooks/${result.id}`);
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Open Srcbook</DialogTitle>
          <DialogDescription asChild>
            <p>
              Open a Srcbook by importing one from a <code className="code">.src.md</code> file.
            </p>
          </DialogDescription>
        </DialogHeader>
        <FilePicker
          cta="Open"
          dirname={fsResult.dirname}
          entries={fsResult.entries}
          onChange={(entry) => {
            void (async () => {
              await onChange(entry);
            })();
          }}
        />
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </DialogContent>
    </Dialog>
  );
}

export function ExportSrcbookModal({
  open,
  onOpenChange,
  session,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: SessionType;
}): JSX.Element {
  const [error, setError] = useState<string | null>(null);

  async function onSave(directory: string, filename: string) {
    try {
      await exportSrcmdFile(session.id, { directory, filename });
      onOpenChange(false);
    } catch (error) {
      console.error(error);
      setError('Something went wrong. Please try again.');
      setTimeout(() => {
        setError(null);
      }, 3000);
    }
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Save to file</DialogTitle>
          <DialogDescription asChild>
            <p>
              Export this Srcbook to a <code className="code">.src.md</code> file which is shareable
              and can be imported into any Srcbook application.
            </p>
          </DialogDescription>
        </DialogHeader>
        <ExportLocationPicker
          onSave={(directory, filename) => {
            void (async () => {
              await onSave(directory, filename);
            })();
          }}
          title={getTitleForSession(session)}
        />
        {error ? <p className="text-destructive-foreground">{error}</p> : null}
      </DialogContent>
    </Dialog>
  );
}
