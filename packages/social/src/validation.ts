import type { MediaRef, PlatformCapabilities, PlatformKey } from './types';

export interface ContentValidationInput {
  platform: PlatformKey;
  caption: string;
  hashtags: string[];
  media: MediaRef[];
}

export interface ContentValidationIssue {
  code:
    | 'PUBLISHING_UNSUPPORTED'
    | 'MEDIA_REQUIRED'
    | 'TEXT_ONLY_UNSUPPORTED'
    | 'CAPTION_TOO_LONG'
    | 'CAPTION_EMPTY'
    | 'TOO_MANY_HASHTAGS'
    | 'TOO_MANY_MEDIA'
    | 'MEDIA_TYPE_UNSUPPORTED'
    | 'MEDIA_TOO_LARGE'
    | 'VIDEO_TOO_LONG'
    | 'VIDEO_UNSUPPORTED'
    | 'IMAGE_UNSUPPORTED'
    | 'CAROUSEL_UNSUPPORTED'
    | 'MEDIA_NOT_PUBLIC';
  message: string;
}

/** Final caption as published: caption plus hashtags not already present in it. */
export function composeCaption(caption: string, hashtags: string[]): string {
  const normalized = hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).filter((h) => h.length > 1);
  const missing = normalized.filter((h) => !caption.toLowerCase().includes(h.toLowerCase()));
  return missing.length ? `${caption.trim()}\n\n${missing.join(' ')}` : caption.trim();
}

const fmtMb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/**
 * Pre-publish validation against a platform's documented constraints.
 * Returns actionable issues; an empty array means the post may be published.
 */
export function validateContentForPlatform(caps: PlatformCapabilities, input: ContentValidationInput): ContentValidationIssue[] {
  const issues: ContentValidationIssue[] = [];
  const { platform } = input;

  if (!caps.publishing) {
    return [{ code: 'PUBLISHING_UNSUPPORTED', message: `${platform} does not support publishing posts through its official API.` }];
  }

  const text = composeCaption(input.caption, input.hashtags);
  const images = input.media.filter((m) => m.kind === 'IMAGE');
  const videos = input.media.filter((m) => m.kind === 'VIDEO');

  if (!input.media.length && !text.trim()) issues.push({ code: 'CAPTION_EMPTY', message: 'Add a caption or media.' });
  if (caps.requiresMedia && input.media.length === 0) {
    issues.push({ code: 'MEDIA_REQUIRED', message: `${platform} posts require at least one image or video.` });
  } else if (!caps.textPublishing && input.media.length === 0) {
    issues.push({ code: 'TEXT_ONLY_UNSUPPORTED', message: `${platform} does not support text-only posts.` });
  }
  if (text.length > caps.maxCaptionLength) {
    issues.push({
      code: 'CAPTION_TOO_LONG',
      message: `Caption is ${text.length} characters including hashtags; ${platform} allows ${caps.maxCaptionLength}.`,
    });
  }
  const tagCount = (text.match(/#[\p{L}\p{N}_]+/gu) ?? []).length;
  if (caps.maxHashtags > 0 && tagCount > caps.maxHashtags) {
    issues.push({ code: 'TOO_MANY_HASHTAGS', message: `${tagCount} hashtags; ${platform} allows ${caps.maxHashtags}.` });
  }
  if (input.media.length > caps.maxMediaItems) {
    issues.push({ code: 'TOO_MANY_MEDIA', message: `${input.media.length} media items; ${platform} allows ${caps.maxMediaItems}.` });
  }
  if (input.media.length > 1 && !caps.carouselPublishing) {
    issues.push({ code: 'CAROUSEL_UNSUPPORTED', message: `${platform} does not support multi-media posts via the API.` });
  }
  if (images.length && !caps.imagePublishing) issues.push({ code: 'IMAGE_UNSUPPORTED', message: `${platform} image publishing is not supported.` });
  if (videos.length && !caps.videoPublishing) issues.push({ code: 'VIDEO_UNSUPPORTED', message: `${platform} video publishing is not supported.` });

  for (const m of input.media) {
    if (m.kind === 'DOCUMENT') {
      issues.push({ code: 'MEDIA_TYPE_UNSUPPORTED', message: `Documents cannot be published to ${platform}.` });
      continue;
    }
    const allowed = m.kind === 'IMAGE' ? caps.supportedImageTypes : caps.supportedVideoTypes;
    if (allowed.length && !allowed.includes(m.mimeType)) {
      issues.push({ code: 'MEDIA_TYPE_UNSUPPORTED', message: `${m.mimeType} is not accepted by ${platform} (allowed: ${allowed.join(', ')}).` });
    }
    const max = m.kind === 'IMAGE' ? caps.maxImageBytes : caps.maxVideoBytes;
    if (max > 0 && m.size > max) {
      issues.push({ code: 'MEDIA_TOO_LARGE', message: `A ${m.kind.toLowerCase()} is ${fmtMb(m.size)}; ${platform} allows ${fmtMb(max)}.` });
    }
    if (m.kind === 'VIDEO' && caps.maxVideoDurationSec > 0 && m.durationSec && m.durationSec > caps.maxVideoDurationSec) {
      issues.push({ code: 'VIDEO_TOO_LONG', message: `Video is ${Math.round(m.durationSec)}s; ${platform} allows ${caps.maxVideoDurationSec}s.` });
    }
    if (!/^https:\/\//.test(m.url) && platform !== 'LINKEDIN') {
      issues.push({
        code: 'MEDIA_NOT_PUBLIC',
        message: `${platform} fetches media from a public HTTPS URL; configure S3_PUBLIC_URL (current URL is not HTTPS).`,
      });
    }
  }
  return issues;
}
