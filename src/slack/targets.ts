// Minimal Slack routing helpers for PR #42162
// This bridges the gap between core routing and the slack extension

export type SlackRoutePeerKind = "direct" | "channel" | "group";

function looksLikeSlackUserId(str: string): boolean {
  return /^U[A-Z0-9]{8,}$/i.test(str);
}

function looksLikeSlackChannelId(str: string): boolean {
  return /^C[A-Z0-9]{8,}$/i.test(str);
}

export function canonicalizeSlackRoutePeerId(params: { kind: SlackRoutePeerKind; raw: string }): {
  id: string;
  didNormalize: boolean;
  usedTargetSyntax: boolean;
} {
  const trimmed = params.raw.trim();
  if (!trimmed) {
    return { id: "", didNormalize: false, usedTargetSyntax: false };
  }

  if (params.kind === "direct") {
    const mention = trimmed.match(/^<@([A-Z0-9]+)>$/i);
    if (mention?.[1]) {
      const id = mention[1].toUpperCase();
      return { id, didNormalize: id !== trimmed, usedTargetSyntax: true };
    }

    const prefixed = trimmed.match(/^(?:slack:|user:)([A-Z0-9]+)$/i);
    if (prefixed?.[1] && looksLikeSlackUserId(prefixed[1])) {
      const id = prefixed[1].toUpperCase();
      return { id, didNormalize: id !== trimmed, usedTargetSyntax: true };
    }

    if (looksLikeSlackUserId(trimmed)) {
      const id = trimmed.toUpperCase();
      return { id, didNormalize: id !== trimmed, usedTargetSyntax: false };
    }

    return { id: trimmed, didNormalize: false, usedTargetSyntax: false };
  }

  const channelMention = trimmed.match(/^<#([A-Z0-9]+)(?:\|[^>]+)?>$/i);
  if (channelMention?.[1]) {
    const id = channelMention[1].toUpperCase();
    return { id, didNormalize: id !== trimmed, usedTargetSyntax: true };
  }

  const channelPrefixed = trimmed.match(/^channel:([A-Z0-9]+)$/i);
  if (channelPrefixed?.[1] && looksLikeSlackChannelId(channelPrefixed[1])) {
    const id = channelPrefixed[1].toUpperCase();
    return { id, didNormalize: id !== trimmed, usedTargetSyntax: true };
  }

  const hashPrefixed = trimmed.match(/^#([A-Z0-9]+)$/i);
  if (hashPrefixed?.[1] && looksLikeSlackChannelId(hashPrefixed[1])) {
    const id = hashPrefixed[1].toUpperCase();
    return { id, didNormalize: id !== trimmed, usedTargetSyntax: true };
  }

  if (looksLikeSlackChannelId(trimmed)) {
    const id = trimmed.toUpperCase();
    return { id, didNormalize: id !== trimmed, usedTargetSyntax: false };
  }

  return { id: trimmed, didNormalize: false, usedTargetSyntax: false };
}
