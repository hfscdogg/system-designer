/** Where a conversation happens. Display names are never part of a route. */
export interface ThreadRef {
  platform: string;
  spaceId: string;
  threadId: string;
}

export function sameThread(a: ThreadRef, b: ThreadRef): boolean {
  return a.platform === b.platform && a.spaceId === b.spaceId && a.threadId === b.threadId;
}
