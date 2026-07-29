export type LoginStatus = {
  status:
    | 'wait'
    | 'scaned'
    | 'confirmed'
    | 'expired'
    | 'scaned_but_redirect'
    | 'need_verifycode'
    | 'verify_code_blocked'
    | 'binded_redirect';
  bot_token?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
  baseurl?: string;
  redirect_host?: string;
};

export type MessageItem = {
  type?: number;
  msg_id?: string;
  text_item?: { text?: string };
  voice_item?: { text?: string };
  file_item?: { file_name?: string };
};

export type WeixinMessage = {
  seq?: number;
  message_id?: number;
  client_id?: string;
  from_user_id?: string;
  to_user_id?: string;
  create_time_ms?: number;
  message_type?: number;
  item_list?: MessageItem[];
  context_token?: string;
};

export type UpdatesResponse = {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
};
