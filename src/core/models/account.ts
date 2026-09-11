export interface Account {
  accountId: string;
  displayName: string | null;
  createdAt: string;
}

export type IdentityChannel = "telegram" | "ios";

export interface ExternalIdentity {
  accountId: string;
  channel: IdentityChannel;
  externalUserId: string;
  createdAt: string;
}

export type PromptMode = "compact" | "enhanced" | "web";
