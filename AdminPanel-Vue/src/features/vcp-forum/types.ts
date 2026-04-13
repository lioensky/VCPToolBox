export interface ForumPost {
  uid: string;
  title: string;
  author: string;
  board: string;
  timestamp: string;
  lastReplyBy?: string | null;
  lastReplyAt?: string | null;
}

export interface ForumReply {
  floor: number;
  author: string;
  content: string;
  contentHtml: string;
  createdAt: string;
}

export interface ForumPostDetail extends ForumPost {
  contentHtml: string;
  replies: number;
  repliesList: ForumReply[];
}
