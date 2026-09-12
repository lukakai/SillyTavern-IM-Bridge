export interface WorldBookSummary {
  id: string;
  name: string;
}

export interface WorldBookDocument extends Record<string, unknown> {
  entries: Record<string, unknown> | unknown[];
}

export interface WorldBookEntryView {
  /** Storage key inside the standalone world-book entries object. */
  ref: string;
  uid: string;
  comment: string;
  content: string;
  keys: string[];
  secondaryKeys: string[];
  enabled: boolean;
}

export interface WorldBookView {
  id: string;
  name: string;
  revision: string;
  entries: WorldBookEntryView[];
}

export interface WorldBookEntryUpdateResult {
  book: WorldBookView;
  entry: WorldBookEntryView;
  backupFileName: string;
}
