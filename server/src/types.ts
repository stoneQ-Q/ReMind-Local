export interface Env {
  DB: D1Database;
  WECHAT_TOKEN: string;
  DEEPSEEK_API_KEY?: string;
  ZHIPU_API_KEY?: string;
}

export type WechatMessage = {
  toUserName: string;
  fromUserName: string;
  createTime: number;
  msgType: string;
  msgId: string;
  content: string;
  title: string;
  description: string;
  url: string;
};

export type InboxMessage = {
  msgId: string;
  type: string;
  content: string;
  linkUrl: string | null;
  userContext: string | null;
  pageTitle: string | null;
  pageSite: string | null;
  pageText: string | null;
  createdAt: string;
};
