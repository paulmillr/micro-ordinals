export type TagCodersType = {
  pointer: P.CoderType<bigint>;
  contentType: P.CoderType<string>;
  parent: P.Coder<string, Uint8Array>;
  metadata: P.CoderType<any>;
  metaprotocol: P.CoderType<string>;
  contentEncoding: P.CoderType<string>;
  delegate: P.Coder<string, Uint8Array>;
  rune: P.CoderType<bigint>;
  note: P.CoderType<string>;
};