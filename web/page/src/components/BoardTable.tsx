// A leaderboard's rows, shared by the Tab window's board tabs and the Leaderboards page
// (BoardTable draws a page of them; the page's scrolling board draws BoardHead and BoardLine itself):
// place, movement, the player (their cycle colour's swatch, name, handle), then the board's own
// columns (leaderboards.ts boardColumns): kills, deaths, K/D, wins, win % on deathmatch; round wins,
// kills, deaths, K/D, match wins, win % on the fortress board. The sorted column is the main
// one, a step heavier, and its head is marked. First place stays as one row on top when the page
// starts lower, with how many more stand above the rows, and reads a step heavier.
//
// Two marks never share a device: the player's own row is a ground a step lighter with YOU (a
// guest's, theirs alone, NOT SAVED in waiting amber); the focused row (the page's) carries the 4u
// ink bar. Movement is a state players read at a glance in every game: up in online green, down in
// failed red, always with its arrow and number, and said in words to a screen reader.
import type { BoardInfo, BoardPage, BoardRow, BoardSort, MyPlace } from "../platform/types";
import { DEFAULT_SORTS, boardColumns, type BoardColumn } from "../platform/leaderboards";
import { QUICK_MODES } from "../modes";
import { num, t } from "../i18n";

// a board's columns when the caller does not say (deathmatch's)
const DEFAULT_COLUMNS = boardColumns(DEFAULT_SORTS);

// a column's head: wins are match wins, said so where round wins stand beside them
// the fortress board counts round wins too (the player card shows them): its wins are MATCH WINS
export function roundsBoard(board: string | null | undefined): boolean {
  return !!board && board === QUICK_MODES.fort?.board;
}

export function columnWord(col: BoardColumn, columns: readonly BoardColumn[], rounds = columns.includes("rounds")): string {
  switch (col) {
    case "rounds":
      return t("game.score.rounds");
    case "kills":
      return t("game.score.kills");
    case "deaths":
      return t("game.score.deaths");
    case "kd":
      return t("game.score.kd");
    case "wins":
      return rounds ? t("game.score.matchWins") : t("game.score.wins");
    case "winpct":
      return t("game.score.winPct");
  }
}

// a win %: "63%" in the page's language, a quiet dash with no counted match. Whole numbers only;
// a share between 0 and 100 never shows as 0% or 100%
export function winPctText(pct: number | null | undefined): string {
  if (pct == null) return "–";
  const whole = pct > 0 && pct < 100 ? Math.min(99, Math.max(1, Math.round(pct))) : Math.round(pct);
  return num(whole / 100, { style: "percent", maximumFractionDigits: 0 });
}

// a column's value in a row
export function columnValue(col: BoardColumn, row: BoardRow): string {
  switch (col) {
    case "rounds":
      return num(row.rounds ?? 0);
    case "kills":
      return num(row.kills);
    case "deaths":
      return num(row.deaths);
    case "kd":
      return kdText(row.kd);
    case "wins":
      return num(row.wins);
    case "winpct":
      return winPctText(row.winPct);
  }
}

// the most a streak line asks for: past it (a long K/D, thousands of kills without dying) the
// line is a number no player can use, so it is not shown
export const STREAK_TO_NEXT_MAX = 20;

// what passing the next player takes, in the sort's own terms; nothing when the platform cannot
// say (null, or a count that is not one: 0 or less), or when a streak (K/D, win %) is too long to be a goal
export function toNextWords(place: MyPlace, sort: BoardSort): string | null {
  if (!place.next || place.toNext === null || !(place.toNext > 0)) return null;
  if ((sort === "kd" || sort === "winpct") && place.toNext > STREAK_TO_NEXT_MAX) return null;
  if (sort === "winpct") return t("game.note.toNextWinPct", { n: place.toNext, name: place.next });
  if (sort === "rounds") return t("game.note.toNextRounds", { n: place.toNext, name: place.next });
  if (sort === "kd") return t("game.note.toNextKd", { n: place.toNext, name: place.next });
  if (sort === "wins") return t("game.note.toNextWins", { n: place.toNext, name: place.next });
  return t("game.note.toNext", { n: place.toNext, name: place.next });
}

// what a caller off the board still needs to get on it, in the sort's terms: counted matches in the
// win % sort, round wins in the round-wins sort, kills (in Fortress matches on the fortress board)
// otherwise (the platform's killsToQualify, a count in the sort's terms); null when it asks nothing
export function qualifyWords(page: BoardPage, sort: BoardSort): string | null {
  const n = page.killsToQualify;
  if (n === null || !(n > 0)) return null;
  if (sort === "winpct") return t("game.score.qualifyMatches", { n });
  if (sort === "kd") return t("game.score.qualifyKd", { n });
  if (sort === "rounds") return t("game.score.qualifyRounds", { n });
  return t(page.board === QUICK_MODES.fort?.board ? "game.score.qualifyFort" : "game.score.qualify", { n });
}

// what a board is, in one quiet line: the Quick Play line's board (the menu says QUICK PLAY where
// the board says DEATHMATCH) or the fortress rules, and in the win % sort how a match counts
export function legendWords(board: string | null | undefined, sort: BoardSort): string {
  const fort = !!board && board === QUICK_MODES.fort?.board;
  const said: string[] = [];
  if (board && board === QUICK_MODES.quick?.board) said.push(t("game.score.legendQuick"));
  if (fort) said.push(t("game.score.legendFort"));
  if (sort === "winpct") {
    said.push(t("game.score.legendWinPct"));
    if (!fort) said.push(t("game.score.legendWinPctWon"));
  }
  return said.join(" ");
}

export function Move({ row }: { row: Pick<BoardRow, "move" | "new"> }) {
  if (row.new) return <span className="bt-move is-new">{t("game.score.new")}</span>;
  if (!row.move) {
    return (
      <span className="bt-move is-same">
        <span aria-hidden="true">–</span>
        <span className="vh">{t("game.score.moveSame")}</span>
      </span>
    );
  }
  const up = row.move > 0;
  return (
    <span className={"bt-move " + (up ? "is-up" : "is-down")}>
      <i className="bt-tri" aria-hidden="true" />
      <span aria-hidden="true">{num(Math.abs(row.move))}</span>
      <span className="vh">{t(up ? "game.score.moveUp" : "game.score.moveDown", { n: Math.abs(row.move) })}</span>
    </span>
  );
}

export function kdText(kd: number): string {
  return num(kd, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// the swatch: the player's cycle colour, or an empty cell when their page never said it
export function Swatch({ color }: { color: string | null | undefined }) {
  return <i className={"bt-swatch" + (color ? "" : " is-unknown")} style={color ? { background: color } : undefined} aria-hidden="true" />;
}

interface BoardTableProps {
  page: BoardPage;
  columns?: readonly BoardColumn[]; // the board's (absent: deathmatch's)
  label: string; // the table's name for a screen reader
  youColor?: string | null; // the player's own colour, which the page knows before the platform does
  focused?: number | null; // the Leaderboards page's focused row (a rank); absent: no row focus (the Tab window)
  onRow?(row: BoardRow): void; // the page: a row pressed
  onSort?(sort: BoardSort): void; // the column heads sort (kills, K/D, wins), as the Server Browser's do
  keyHeads?: boolean; // the heads take the keyboard focus (the page); the Tab window's take the pointer only
}

// a row as a screen reader says it: the place, the player, the movement, every column by name
function rowLabel(row: BoardRow, columns: readonly BoardColumn[]): string {
  const move = row.new
    ? t("game.score.new")
    : !row.move
      ? t("game.score.moveSame")
      : t(row.move > 0 ? "game.score.moveUp" : "game.score.moveDown", { n: Math.abs(row.move) });
  const vars = { rank: num(row.rank), name: row.name, move, kills: num(row.kills), deaths: num(row.deaths), kd: kdText(row.kd), wins: num(row.wins) };
  let said = columns.includes("rounds")
    ? t("game.score.rowLabelRounds", { ...vars, rounds: num(row.rounds ?? 0) })
    : t("game.score.rowLabel", vars);
  if (columns.includes("winpct")) said += ", " + (row.winPct == null ? t("game.score.rowNoMatches") : t("game.score.rowWinPct", { pct: winPctText(row.winPct) }));
  return row.you ? said + " " + (row.saved ? t("game.players.you") : t("game.score.notSaved")) : said;
}

interface BoardHeadProps {
  sort: BoardSort;
  columns?: readonly BoardColumn[];
  onSort?(sort: BoardSort): void;
  keyHeads?: boolean;
  board?: string | null;
}

// the column heads, the sorted one marked
export function BoardHead({ sort, columns = DEFAULT_COLUMNS, onSort, keyHeads, board }: BoardHeadProps) {
  const head = (key: BoardColumn, word: string) => (
    <th key={key} scope="col" data-col={key} className={key === sort ? "is-sorted" : undefined} aria-sort={key === sort ? "descending" : undefined}>
      {onSort && key !== "deaths" ? (
        <button
          type="button"
          className="bt-sort"
          data-sort={key}
          tabIndex={keyHeads ? 0 : -1}
          onMouseDown={keyHeads ? undefined : (e) => e.preventDefault()}
          onClick={() => onSort(key)}
        >
          {word}
        </button>
      ) : (
        word
      )}
    </th>
  );
  return (
    <tr>
      <th scope="col" className="bt-l">{t("game.score.rank")}</th>
      <th scope="col" className="bt-l" aria-label={t("game.score.move")} />
      <th scope="col" className="bt-l">{t("game.score.player")}</th>
      {columns.map((c) => head(c, columnWord(c, columns, columns.includes("rounds") || roundsBoard(board))))}
    </tr>
  );
}

interface BoardLineProps {
  row: BoardRow;
  columns?: readonly BoardColumn[];
  sort?: BoardSort; // the sorted column, the main one (absent: the first)
  youColor?: string | null;
  focused?: number | null; // absent: no row focus (the Tab window)
  onRow?(row: BoardRow): void;
  rowIndex?: number; // aria-rowindex, when only some of the rows are drawn (the page's scrolling board)
}

export function BoardLine({ row, columns = DEFAULT_COLUMNS, sort, youColor, focused, onRow, rowIndex }: BoardLineProps) {
  const interactive = focused !== undefined;
  const main = sort && columns.includes(sort) ? sort : columns[0];
  const on = interactive && focused === row.rank;
  return (
    <tr
      className={(row.you ? "is-you" : "") + (on ? " is-focus" : "") + (row.rank === 1 ? " is-first" : "")}
      data-rank={row.rank}
      aria-rowindex={rowIndex}
      aria-selected={interactive ? on : undefined}
      aria-label={rowLabel(row, columns)}
      tabIndex={interactive ? (on ? 0 : -1) : undefined}
      onClick={onRow ? () => onRow(row) : undefined}
    >
      <td className="bt-rank">{num(row.rank)}</td>
      <td className="bt-movecell">
        <Move row={row} />
      </td>
      <td className="bt-who">
        <div className="bt-who-in">
          <Swatch color={row.you ? youColor ?? row.color : row.color} />
          {row.you && !row.saved && <i className="bt-dot" aria-hidden="true" />}
          <span className="bt-name">{row.name}</span>
          {row.handle && <span className="bt-handle">@{row.handle}</span>}
          {row.you && <span className={"bt-mark" + (row.saved ? "" : " is-unsaved")}>{row.saved ? t("game.players.you") : t("game.score.notSaved")}</span>}
        </div>
      </td>
      {columns.map((c) => (
        <td key={c} className={"bt-num" + (c === main ? " bt-main" : "")} data-col={c}>
          {columnValue(c, row)}
        </td>
      ))}
    </tr>
  );
}

// a place whose row is on its way: its number, quiet dashes for the rest
export function PendingLine({ rank, columns = DEFAULT_COLUMNS, focused, rowIndex, onRow }: { rank: number; columns?: readonly BoardColumn[]; focused?: number | null; rowIndex?: number; onRow?(): void }) {
  const on = focused === rank;
  return (
    <tr className={"bt-pending" + (on ? " is-focus" : "")} data-rank={rank} aria-rowindex={rowIndex} aria-selected={on} aria-busy="true" tabIndex={on ? 0 : -1} onClick={onRow}>
      <td className="bt-rank">{num(rank)}</td>
      <td className="bt-movecell" />
      <td className="bt-who">
        <span className="bt-name">–</span>
      </td>
      {columns.map((c) => (
        <td key={c} className="bt-num" data-col={c}>
          –
        </td>
      ))}
    </tr>
  );
}

export function BoardTable({ page, columns = DEFAULT_COLUMNS, label, youColor, focused, onRow, onSort, keyHeads }: BoardTableProps) {
  const interactive = focused !== undefined;
  const leaderApart = page.leader && page.rows.length > 0 && page.rows[0].rank > 1;
  const above = page.rows.length ? page.rows[0].rank - (leaderApart ? 2 : 1) : 0;
  const line = (row: BoardRow) => <BoardLine key={row.rank + ":" + row.name} row={row} columns={columns} sort={page.sort} youColor={youColor} focused={focused} onRow={onRow} />;
  return (
    <table className="bt" data-sort={page.sort} data-cols={columns.length} role={interactive ? "grid" : undefined} aria-label={label}>
      <thead>
        <BoardHead sort={page.sort} columns={columns} onSort={onSort} keyHeads={keyHeads} board={page.board} />
      </thead>
      <tbody>
        {leaderApart && page.leader && line(page.leader)}
        {leaderApart && above > 0 && (
          <tr className="bt-gap">
            <td colSpan={columns.length + 3}>{t("game.score.above", { n: above })}</td>
          </tr>
        )}
        {page.rows.map(line)}
      </tbody>
    </table>
  );
}

// a board while its rows are on their way: the columns, with quiet dashes for rows (no spinner)
export function BoardSkeleton({ rows = 11, columns = DEFAULT_COLUMNS }: { rows?: number; columns?: readonly BoardColumn[] }) {
  return (
    <table className="bt is-loading" data-cols={columns.length} aria-hidden="true">
      <tbody>
        {Array.from({ length: rows }, (_, i) => (
          <tr key={i}>
            <td className="bt-rank">–</td>
            <td className="bt-movecell" />
            <td className="bt-who">
              <span className="bt-name">–</span>
            </td>
            {columns.map((c) => (
              <td key={c} className="bt-num" data-col={c}>
                –
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// a pointer press that must not take the focus from the game (the Tab window)
const keepFocus = (e: { preventDefault(): void }) => e.preventDefault();

interface ModeSwitchProps {
  boards: readonly BoardInfo[];
  board: string | null; // the open one (absent from the list: the first)
  onPick(id: string): void;
  overGame?: boolean; // the Tab window: the pointer only, the game keeps the keys and the focus
}

// the boards side by side, the open one marked as the time windows' tab is (DEATHMATCH FORTRESS):
// a radio group, one Tab stop, the arrows along it (Leaderboards.tsx). More than three boards
// would crowd the line: then MODE and the open one between two chevrons. Nothing with one board.
export function ModeSwitch({ boards, board, onPick, overGame }: ModeSwitchProps) {
  const current = boards.find((b) => b.id === board) ?? boards[0];
  if (!current || boards.length < 2) return null;
  const pointer = overGame ? { tabIndex: -1, onMouseDown: keepFocus } : {};
  if (boards.length > 3) {
    const step = (by: number) => onPick(boards[(boards.indexOf(current) + by + boards.length) % boards.length].id);
    return (
      <span className={"sc-choice" + (overGame ? "" : " lb-mode")}>
        <span className="sc-choice-key">{t("game.score.mode")}</span>
        <button type="button" className="sc-chev" aria-label={t("game.score.modePrev")} {...pointer} onClick={() => step(-1)} />
        <span className="sc-choice-value">{current.name}</span>
        <button type="button" className="sc-chev is-next" aria-label={t("game.score.modeNext")} {...pointer} onClick={() => step(1)} />
      </span>
    );
  }
  return (
    <div className={overGame ? "sc-modes" : "sb-scopes lb-modes"} role="radiogroup" aria-label={t("game.score.mode")}>
      {boards.map((b) => {
        const on = b.id === current.id;
        return (
          <button
            key={b.id}
            type="button"
            role="radio"
            aria-checked={on}
            data-board={b.id}
            className={(overGame ? "sc-mode" : "sb-tab lb-mode-o") + (on ? " is-on" : "")}
            tabIndex={on && !overGame ? 0 : -1}
            onMouseDown={overGame ? keepFocus : undefined}
            onClick={() => !on && onPick(b.id)}
          >
            {b.name}
          </button>
        );
      })}
    </div>
  );
}

// "7h 12m", from the window's resetsAt
export function resetsText(resetsAt: string | null, now = Date.now()): string | null {
  if (!resetsAt) return null;
  const left = Math.max(0, Date.parse(resetsAt) - now);
  const minutes = Math.ceil(left / 60000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? t("game.score.hoursMinutes", { h, m }) : t("game.score.minutes", { m });
}

// what the window's movement compares with: an hour ago on today, the day's start on the others
export function movementWords(window: string): string {
  return window === "today" ? t("game.score.sinceHour") : t("game.score.sinceDay");
}
