// token-radar-01: score the sealed snapshot and lay out the entry.
//
// Run it from the repository root. It takes the snapshot from --input
// (a snapshot.json file or the directory holding one), scores every
// pre-token protocol through lib/model.ts, and fills the output
// directory with board.json, data.js, the dashboard, the screenshots
// and dossier.json, in that order. The dossier goes last because the
// vendored builder re-reads the finished output to describe it.
//
// The output directory comes from --output, else MAKEFUN_OUTPUT_DIR,
// else /output. Outside the grader, MAKEFUN_OUTPUT_DIR=out is the
// usual spell:
//   MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as radar from './lib/model.ts';
import * as dossier from './vendor/makefun-board.ts';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

// Caps the dossier builder works under, matching the gate's own
// limits so a run that would overflow them fails loudly instead of
// handing in a bad dossier.
const dossierCaps = {
  text_max_bytes: 65536,
  screenshots: { max: 4, max_bytes: 524288 },
  dashboard: { max_files: 400, max_bytes: 4194304 },
};

const SHOT_NAME = new RegExp('^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$');

// Stop the run with a message on stderr and the given exit code.
function die(message: string, code: number): never {
  process.stderr.write('token radar: ' + message + '\n');
  process.exit(code);
}

// The command line as a map of --name to value, plus the bare switches
// (--strict and friends) that take no value. A --name=value token
// splits on the first '='; a --name token takes the next token when
// that token is not itself a flag.
function readFlags(argv: string[]): { values: Map<string, string>; switches: Set<string> } {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  let i = 0;
  while (i < argv.length) {
    const token = argv[i]!;
    i += 1;
    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        values.set(body.slice(0, eq), body.slice(eq + 1));
      } else {
        const next = argv[i];
        if (next !== undefined && !next.startsWith('--')) {
          values.set(body, next);
          i += 1;
        } else {
          switches.add(body);
        }
      }
    }
  }
  return { values, switches };
}

const { values: flagValues, switches: flagSwitches } = readFlags(process.argv.slice(2));

function flag(name: string, fallback: string): string {
  const found = flagValues.get(name);
  return found === undefined ? fallback : found;
}

const inputGiven = flag('input', '/input');
const inputFile = inputGiven.endsWith('.json') ? inputGiven : path.join(inputGiven, 'snapshot.json');
if (!fs.existsSync(inputFile)) {
  die(
    'no snapshot at ' + inputFile + ': pass --input <snapshot.json|directory> or mount the sealed /input',
    2,
  );
}
const outDir = flag('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = radar.parseSnapshot(fs.readFileSync(inputFile, 'utf8'));
const { board, radar: radarData } = radar.buildRadar(snapshot);
const boardProblem = radar.boardIssue(board, snapshot);
if (boardProblem !== null) {
  die('the model wrote a board the gate refuses: ' + boardProblem, 1);
}
if (flagSwitches.has('strict')) {
  const strictProblem = radar.strictBoardChecks(board, snapshot);
  if (strictProblem !== null) {
    die('the strict checks refuse the board: ' + strictProblem, 1);
  }
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'board.json'), JSON.stringify({ rows: board }) + '\n');
fs.writeFileSync(path.join(outDir, 'data.js'), radar.dataScript(radarData));

// Copy every regular file out of one directory, leaving dotfiles
// behind, and report the names that landed.
function copyDir(from: string, to: string): string[] {
  const landed: string[] = [];
  if (fs.existsSync(from)) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (entry.isFile() && !entry.name.startsWith('.')) {
        fs.copyFileSync(path.join(from, entry.name), path.join(to, entry.name));
        landed.push(entry.name);
      }
    }
  }
  return landed;
}

copyDir(path.join(repoRoot, 'dashboard'), path.join(outDir, 'dashboard'));
const shots = copyDir(path.join(repoRoot, 'screenshots'), path.join(outDir, 'screenshots'));
if (shots.length < 3) {
  die(
    'screenshots/ holds ' + shots.length + (shots.length === 1 ? ' image' : ' images') +
      ': hand in 3, the board, a detail view and a filtered view',
    1,
  );
}
for (const shot of shots) {
  if (!SHOT_NAME.test(shot)) {
    die('screenshots/' + shot + ': a name is letters, digits and . _ -, 1 to 128 characters', 1);
  }
}

// The dossier is written last: the scorer rebuilds it from this
// output and compares bytes, so nothing may change after this point.
fs.writeFileSync(path.join(outDir, 'dossier.json'), dossier.buildDossier(outDir, dossierCaps));

const report = [
  'token radar: ' + snapshot.protocols.length + ' protocols, ' + snapshot.watchlist.length +
    ' on the watchlist, ' + board.length + ' rows scored (' + radarData.early_size +
    ' early, ' + radarData.live_size + ' live set aside)',
  'token radar: wrote ' + path.join(outDir, 'board.json') + ', ' + path.join(outDir, 'data.js') +
    ', ' + path.join(outDir, 'dashboard') + ' (3 files), ' + path.join(outDir, 'screenshots') +
    ' (' + shots.length + ' images) and ' + path.join(outDir, 'dossier.json'),
];
process.stdout.write(report.join('\n') + '\n');
