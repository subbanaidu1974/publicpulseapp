/**
 * Count-day feed types (S-41, E2E-50, DESIGN_2028 3.7 and 3.8 item 6).
 *
 * FeedBatch is the neutral INPUT schema every ResultsSource produces. Snapshot/AcView are the signed OUTPUT.
 * No source here is verified: the fixture is SYNTHETIC, the file-drop is whatever an operator places, the TCPD source is a
 * delayed archive and the HTTP source has no default URL. Nothing in this module scrapes any site.
 */
export const FEED_SCHEMA = 1;
export const SNAPSHOT_SCHEMA = 1;

export type SourceKind = "fixture" | "file-drop" | "tcpd-delayed" | "http";
export type CountStatus = "not_started" | "counting" | "declared";
/** Seat label shown to the public. "won" only ever comes from status === "declared" in the feed. */
export type SeatLabel = "not_started" | "leading" | "tied" | "won";
/** live = primary source current; delayed-fallback = fallback archive source; synthetic = test/demo data. */
export type DelayLabel = "live" | "delayed-fallback" | "synthetic";

export interface FeedCandidate { candidate: string; party: string; votes: number }
export interface FeedAc {
  acNo: number;
  acName: string;
  status: CountStatus;
  /** Cumulative votes are reported after this round (0 = nothing counted yet). */
  round: number;
  totalRounds: number | null;
  validVotes?: number | null;
  candidates: FeedCandidate[];
  /** Present when the feed restates an earlier figure downward or changes a declared seat. Needs a non-empty reason. */
  correction?: { reason: string } | null;
}
export interface FeedBatch {
  schema: 1;
  sourceId: string;
  sourceKind: SourceKind;
  synthetic: boolean;
  state: string;
  electionType: "assembly" | "ls";
  year: number;
  /** ISO instant at which the source produced this batch. */
  asOf: string;
  acs: FeedAc[];
}

export interface ResultsSource {
  id: string;
  kind: SourceKind;
  /** Human label, shown in operator tools. */
  label: string;
  /** Returns the current batch, or throws when the source is down or not configured. Never scrapes. */
  fetch(now: Date): Promise<FeedBatch>;
}

export interface AcLink { kind: "form20" | "affidavit" | "results-portal"; label: string; url: string; verified: boolean }
export interface AcView {
  acNo: number;
  acName: string;
  status: CountStatus;
  label: SeatLabel;
  round: number;
  totalRounds: number | null;
  validVotes: number | null;
  totalVotes: number;
  leader: { candidate: string; party: string; votes: number } | null;
  margin: number | null;
  candidates: FeedCandidate[];
  /** True when a newer figure for this seat is held back pending two-person review. The figures shown are the last approved ones. */
  underReview: boolean;
  asOf: string;
}

export interface SnapshotBody {
  schema: 1;
  kind: "countday-snapshot";
  state: string;
  seq: number;
  asOf: string;
  publishedAt: string;
  sourceId: string;
  sourceKind: SourceKind;
  synthetic: boolean;
  delayLabel: DelayLabel;
  electionType: "assembly" | "ls";
  year: number;
  /** sha256 of the previous snapshot body (null for seq 1). */
  prevHash: string | null;
  summary: { total: number; notStarted: number; counting: number; declared: number; underReview: number; leading: Record<string, number>; won: Record<string, number> };
  links: AcLink[];
  /** sha256 of the canonical JSON of each AcView, by acNo. */
  acHashes: Record<string, string>;
  acs: AcView[];
  notice: { en: string; te: string };
}
export interface Signature { alg: "ed25519"; keyId: string; value: string }
export interface Envelope<T> { body: T; sha256: string; signature: Signature }

export interface AcBody {
  schema: 1;
  kind: "countday-ac";
  state: string;
  acNo: number;
  snapshotSeq: number;
  snapshotSha256: string;
  asOf: string;
  delayLabel: DelayLabel;
  synthetic: boolean;
  sourceId: string;
  acSha256: string;
  ac: AcView;
  links: AcLink[];
  notice: { en: string; te: string };
}

export interface IndexEntry { seq: number; asOf: string; publishedAt: string; sha256: string; prevHash: string | null; bytes: number; sourceId: string; delayLabel: DelayLabel; keyId: string }
export interface IndexBody { schema: 1; kind: "countday-index"; state: string; entries: IndexEntry[]; head: { seq: number; sha256: string } | null }
export interface IndexFile { body: IndexBody; sha256: string; signature: Signature }

export interface Signer { keyId: string; publicKey: string; sign(data: Buffer): string }
export interface PublicKeyRecord { keyId: string; alg: "ed25519"; x: string; addedAt: string }
export interface KeysFile { schema: 1; algorithm: "ed25519"; keys: PublicKeyRecord[]; note: string }

export const NOTICE_SYNTHETIC = { en: "SYNTHETIC test data. These are not real counts.", te: "కృత్రిమ పరీక్ష డేటా. ఇవి నిజమైన లెక్కింపు గణాంకాలు కావు." };
export const NOTICE_LIVE = { en: "Counting figures from the source named here. A seat is shown as won only after it is declared.", te: "ఇక్కడ పేర్కొన్న మూలం నుంచి లెక్కింపు గణాంకాలు. ప్రకటించిన తర్వాత మాత్రమే స్థానం గెలిచినట్లు చూపబడుతుంది." };
export const NOTICE_DELAYED = { en: "Delayed archive figures, not a live feed. Declared seats only.", te: "ఆలస్యంగా వచ్చిన ఆర్కైవ్ గణాంకాలు, ప్రత్యక్ష ప్రసారం కాదు. ప్రకటించిన స్థానాలు మాత్రమే." };
