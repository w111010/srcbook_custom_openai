import Path from 'node:path';
import { ChildProcess } from 'node:child_process';
import {
  findSession,
  findCell,
  replaceCell,
  updateSession,
  readPackageJsonContentsFromDisk,
  updateCell,
} from '../session.mjs';
import { getSecrets } from '../config.mjs';
import type { SessionType } from '../types.mjs';
import { node, npmInstall, tsx } from '../exec.mjs';
import { shouldNpmInstall, missingUndeclaredDeps } from '../deps.mjs';
import processes from '../processes.mjs';
import type {
  CodeCellType,
  PackageJsonCellType,
  CellExecPayloadType,
  DepsInstallPayloadType,
  DepsValidatePayloadType,
  CellStopPayloadType,
  CellUpdatePayloadType,
  TsServerStartPayloadType,
  TsServerStopPayloadType,
} from '@srcbook/shared';
import {
  CellErrorPayloadSchema,
  CellUpdatePayloadSchema,
  CellExecPayloadSchema,
  CellStopPayloadSchema,
  DepsInstallPayloadSchema,
  DepsValidatePayloadSchema,
  CellUpdatedPayloadSchema,
  CellOutputPayloadSchema,
  DepsValidateResponsePayloadSchema,
  TsServerStartPayloadSchema,
  TsServerStopPayloadSchema,
} from '@srcbook/shared';
import tsservers from '../tsservers.mjs';
import { TsServer } from '../tsserver/tsserver.mjs';
import WebSocketServer from './ws-client.mjs';
import { pathToCodeFile } from '../srcbook/path.mjs';
import { formatDiagnostic } from '../tsserver/utils.mjs';

const wss = new WebSocketServer();

function addRunningProcess(
  session: SessionType,
  cell: CodeCellType | PackageJsonCellType,
  process: ChildProcess,
) {
  // If the process was not successfully started, inform the client the cell is 'idle' again.
  //
  // TODO:
  //
  //     1. If process couldn't start due to an error, add error handling so the client knows
  //     2. Ensure that there's no way the process could have started and successfully exited before we get here, causing the client to think it didn't run but it did.
  //
  if (!process.pid || process.killed) {
    cell.status = 'idle';
    wss.broadcast(`session:${session.id}`, 'cell:updated', { cell });
  } else {
    processes.add(session.id, cell.id, process);
  }
}

async function nudgeMissingDeps(wss: WebSocketServer, session: SessionType) {
  try {
    if (await shouldNpmInstall(session.dir)) {
      wss.broadcast(`session:${session.id}`, 'deps:validate:response', {});
    }
  } catch (e) {
    // Don't crash the server on dependency validation, but log the error
    console.error(`Error validating dependencies for session ${session.id}: ${e}`);
  }

  try {
    const missingDeps = await missingUndeclaredDeps(session.dir);

    if (missingDeps.length > 0) {
      wss.broadcast(`session:${session.id}`, 'deps:validate:response', { packages: missingDeps });
    }
  } catch (e) {
    // Don't crash the server on dependency validation, but log the error
    console.error(`Error running depcheck for session ${session.id}: ${e}`);
  }
}

async function cellExec(payload: CellExecPayloadType) {
  const session = await findSession(payload.sessionId);
  const cell = findCell(session, payload.cellId);

  if (!cell || cell.type !== 'code') {
    console.error(`Cannot execute cell with id ${payload.cellId}; cell not found.`);
    return;
  }

  nudgeMissingDeps(wss, session);

  const secrets = await getSecrets();

  cell.status = 'running';
  wss.broadcast(`session:${session.id}`, 'cell:updated', { cell });

  switch (cell.language) {
    case 'javascript':
      jsExec({ session, cell, secrets });
      break;
    case 'typescript':
      tsxExec({ session, cell, secrets });
      break;
  }
}

type ExecRequestType = {
  session: SessionType;
  cell: CodeCellType;
  secrets: Record<string, string>;
};

async function jsExec({ session, cell, secrets }: ExecRequestType) {
  addRunningProcess(
    session,
    cell,
    node({
      cwd: session.dir,
      env: secrets,
      entry: pathToCodeFile(session.dir, cell.filename),
      stdout(data) {
        wss.broadcast(`session:${session.id}`, 'cell:output', {
          cellId: cell.id,
          output: { type: 'stdout', data: data.toString('utf8') },
        });
      },
      stderr(data) {
        wss.broadcast(`session:${session.id}`, 'cell:output', {
          cellId: cell.id,
          output: { type: 'stderr', data: data.toString('utf8') },
        });
      },
      onExit() {
        // Reload cell to get most recent version which may have been updated since
        // in the time between initially running this cell and when running finishes.
        //
        // TODO: Real state management pls.
        //
        const mostRecentCell = session.cells.find((c) => c.id === cell.id) as CodeCellType;
        mostRecentCell.status = 'idle';
        wss.broadcast(`session:${session.id}`, 'cell:updated', { cell: mostRecentCell });
      },
    }),
  );
}

async function tsxExec({ session, cell, secrets }: ExecRequestType) {
  addRunningProcess(
    session,
    cell,
    tsx({
      cwd: session.dir,
      env: secrets,
      entry: pathToCodeFile(session.dir, cell.filename),
      stdout(data) {
        wss.broadcast(`session:${session.id}`, 'cell:output', {
          cellId: cell.id,
          output: { type: 'stdout', data: data.toString('utf8') },
        });
      },
      stderr(data) {
        wss.broadcast(`session:${session.id}`, 'cell:output', {
          cellId: cell.id,
          output: { type: 'stderr', data: data.toString('utf8') },
        });
      },
      onExit() {
        // Reload cell to get most recent version which may have been updated since
        // in the time between initially running this cell and when running finishes.
        //
        // TODO: Real state management pls.
        //
        const mostRecentCell = session.cells.find((c) => c.id === cell.id) as CodeCellType;
        mostRecentCell.status = 'idle';
        wss.broadcast(`session:${session.id}`, 'cell:updated', { cell: mostRecentCell });
      },
    }),
  );
}

async function depsInstall(payload: DepsInstallPayloadType) {
  const session = await findSession(payload.sessionId);
  const cell = session.cells.find(
    (cell) => cell.type === 'package.json',
  ) as PackageJsonCellType | void;

  if (!cell) {
    console.error(`Cannot install deps; package.json cell not found`);
    return;
  }

  cell.status = 'running';
  wss.broadcast(`session:${session.id}`, 'cell:updated', { cell });

  addRunningProcess(
    session,
    cell,
    npmInstall({
      cwd: session.dir,
      packages: payload.packages,
      stdout(data) {
        wss.broadcast(`session:${session.id}`, 'cell:output', {
          cellId: cell.id,
          output: { type: 'stdout', data: data.toString('utf8') },
        });
      },
      stderr(data) {
        wss.broadcast(`session:${session.id}`, 'cell:output', {
          cellId: cell.id,
          output: { type: 'stderr', data: data.toString('utf8') },
        });
      },
      async onExit() {
        const updatedJsonSource = await readPackageJsonContentsFromDisk(session);
        const updatedCell: PackageJsonCellType = {
          ...cell,
          source: updatedJsonSource,
          status: 'idle',
        };
        updateSession(session, { cells: replaceCell(session, updatedCell) }, false);
        wss.broadcast(`session:${session.id}`, 'cell:updated', { cell: updatedCell });
      },
    }),
  );
}

async function depsValidate(payload: DepsValidatePayloadType) {
  const session = await findSession(payload.sessionId);
  nudgeMissingDeps(wss, session);
}

async function cellStop(payload: CellStopPayloadType) {
  const session = await findSession(payload.sessionId);
  const cell = findCell(session, payload.cellId);

  if (!cell || cell.type !== 'code') {
    return;
  }

  const killed = processes.kill(session.id, cell.id);

  if (!killed) {
    console.error(
      `Attempted to kill process for session ${session.id} and cell ${cell.id} but it didn't die`,
    );
  }
}

async function cellUpdate(payload: CellUpdatePayloadType) {
  const session = await findSession(payload.sessionId);

  if (!session) {
    throw new Error(`No session exists for session '${payload.sessionId}'`);
  }

  const cell = findCell(session, payload.cellId);

  if (!cell) {
    throw new Error(
      `No cell exists for session '${payload.sessionId}' and cell '${payload.cellId}'`,
    );
  }

  const result = await updateCell(session, cell, payload.updates);

  if (!result.success) {
    wss.broadcast(`session:${session.id}`, 'cell:error', {
      sessionId: session.id,
      cellId: cell.id,
      errors: result.errors,
    });

    // Revert the client's optimistic updates with most recent server cell state
    wss.broadcast(`session:${session.id}`, 'cell:updated', {
      cell: findCell(session, payload.cellId),
    });

    return;
  }

  if (
    session.metadata.language === 'typescript' &&
    result.cell.type === 'code' &&
    tsservers.has(session.id)
  ) {
    const cell = result.cell;
    const tsserver = tsservers.get(session.id);

    const file = Path.join(session.dir, cell.filename);

    // To update a file in tsserver, close and reopen it. I assume performance of
    // this implementation is worse than calculating diffs and using `change` command
    // (although maybe not since this is not actually reading or writing to disk).
    // However, that requires calculating diffs which is more complex and may also
    // have performance implications, so sticking with the simple approach for now.
    //
    // TODO: In either case, we should be aggressively debouncing these updates.
    //
    tsserver.close({ file });
    tsserver.open({ file, fileContent: cell.source });

    sendTypeScriptDiagnostics(tsserver, session, cell);
  }
}

/**
 * Send semantic diagnostics for a TypeScript cell to the client.
 */
async function sendTypeScriptDiagnostics(
  tsserver: TsServer,
  session: SessionType,
  cell: CodeCellType,
) {
  const response = await tsserver.semanticDiagnosticsSync({
    file: Path.join(session.dir, cell.filename),
  });

  const diagnostics = response.body || [];

  for (const diagnostic of diagnostics) {
    wss.broadcast(`session:${session.id}`, 'cell:output', {
      cellId: cell.id,
      output: {
        type: 'tsc',
        data: formatDiagnostic(diagnostic),
      },
    });
  }
}

function sendAllTypeScriptDiagnostics(tsserver: TsServer, session: SessionType) {
  for (const cell of session.cells) {
    if (cell.type === 'code') {
      sendTypeScriptDiagnostics(tsserver, session, cell);
    }
  }
}

async function tsserverStart(payload: TsServerStartPayloadType) {
  const session = await findSession(payload.sessionId);

  if (!session) {
    throw new Error(`No session exists for session '${payload.sessionId}'`);
  }

  if (session.metadata.language !== 'typescript') {
    throw new Error(`tsserver can only be used with TypeScript Srcbooks.`);
  }

  if (!tsservers.has(session.id)) {
    const tsserver = tsservers.create(session.id, { cwd: session.dir });

    // Open all code cells in tsserver
    for (const cell of session.cells) {
      if (cell.type === 'code') {
        tsserver.open({
          file: Path.join(session.dir, cell.filename),
          fileContent: cell.source,
        });
      }
    }
  }

  sendAllTypeScriptDiagnostics(tsservers.get(session.id), session);
}

async function tsserverStop(payload: TsServerStopPayloadType) {
  tsservers.shutdown(payload.sessionId);
}

wss
  .channel('session:*')
  .incoming('cell:exec', CellExecPayloadSchema, cellExec)
  .incoming('cell:stop', CellStopPayloadSchema, cellStop)
  .incoming('cell:update', CellUpdatePayloadSchema, cellUpdate)
  .incoming('deps:install', DepsInstallPayloadSchema, depsInstall)
  .incoming('deps:validate', DepsValidatePayloadSchema, depsValidate)
  .incoming('tsserver:start', TsServerStartPayloadSchema, tsserverStart)
  .incoming('tsserver:stop', TsServerStopPayloadSchema, tsserverStop)
  .outgoing('cell:updated', CellUpdatedPayloadSchema)
  .outgoing('cell:error', CellErrorPayloadSchema)
  .outgoing('cell:output', CellOutputPayloadSchema)
  .outgoing('deps:validate:response', DepsValidateResponsePayloadSchema);

export default wss;
