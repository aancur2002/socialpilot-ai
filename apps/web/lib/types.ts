// Response shapes used by the UI (subset of what the API returns).
import type { PlatformKey, IntentKey } from '@socialpilot/validation';

export type { PlatformKey, IntentKey };

export interface Me {
  user: { id: string; email: string; name: string; isSuperAdmin: boolean };
  organizations: { id: string; name: string; slug: string; plan: string; role: string; onboardingStep: string | null }[];
}

export interface CurrentOrg {
  id: string;
  name: string;
  plan: string;
  role: string;
  permissions: string[];
  clientIds: string[] | null;
  mockMode: boolean;
  onboardingStep: string | null;
  limits: Record<string, number>;
  usage: Record<string, number | string>;
}

export interface BrandProfile {
  brandName: string;
  industry: string | null;
  description: string | null;
  tone: string | null;
  targetAudience: string | null;
  services: string[];
  products: string[];
  location: string | null;
  website: string | null;
  phone: string | null;
  email: string | null;
  brandRules: string[];
  forbiddenTopics: string[];
  preferredHashtags: string[];
  cta: string | null;
}

export interface ClientSettings {
  aiEnabled: boolean;
  autoReplyEnabled: boolean;
  autoPublishEnabled: boolean;
  humanApprovalRequired: boolean;
  defaultTone: string | null;
  defaultLanguage: string;
  defaultCta: string | null;
  autoReplyThreshold: number;
  approvalThreshold: number;
  allowedAutoIntents: IntentKey[];
  escalationIntents: IntentKey[];
  businessHours: Record<string, { start: string; end: string }[]>;
  afterHoursMode: 'REPLY_NORMALLY' | 'SEND_AFTER_HOURS_MESSAGE' | 'QUEUE_FOR_BUSINESS_HOURS';
  afterHoursMessage: string | null;
  maxPublishAttempts: number | null;
}

export interface Client {
  id: string;
  name: string;
  slug: string;
  status: 'ACTIVE' | 'ARCHIVED';
  timezone: string;
  updatedAt?: string;
  brandProfile: BrandProfile | null;
  settings?: ClientSettings | null;
  _count?: { socialAccounts: number; contents: number; leads: number };
}

export interface Capabilities {
  publishing: boolean;
  textPublishing: boolean;
  imagePublishing: boolean;
  videoPublishing: boolean;
  carouselPublishing: boolean;
  comments: boolean;
  commentReplies: boolean;
  directMessages: boolean;
  analytics: boolean;
  webhooks: boolean;
  requiresMedia: boolean;
  maxCaptionLength: number;
  notes: string[];
}

export interface SocialAccount {
  id: string;
  clientId: string;
  platform: PlatformKey;
  isMock: boolean;
  displayName: string;
  username: string | null;
  avatarUrl: string | null;
  status: 'ACTIVE' | 'TOKEN_EXPIRED' | 'REAUTH_REQUIRED' | 'DISCONNECTED' | 'ERROR';
  capabilities: Capabilities;
  scopes: string[];
  lastSyncedAt: string | null;
  lastError: string | null;
  createdAt: string;
  profile: { followers: number | null; postsCount: number | null; profileUrl: string | null } | null;
  token: { expiresAt: string | null; revokedAt: string | null } | null;
}

export interface PlatformStatus {
  platform: PlatformKey;
  implemented: boolean;
  configured: boolean;
  mockAvailable: boolean;
  verification: 'UNVERIFIED';
  capabilities: Capabilities;
  docsPath: string;
}

export type ContentStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'SCHEDULED' | 'PUBLISHING' | 'PUBLISHED' | 'FAILED' | 'CANCELLED';

export interface MediaAsset {
  id: string;
  url: string;
  fileName: string;
  mimeType: string;
  kind: 'IMAGE' | 'VIDEO' | 'DOCUMENT';
  size: number;
  width: number | null;
  height: number | null;
}

export interface Variant {
  id: string;
  platform: PlatformKey;
  socialAccountId: string | null;
  title: string | null;
  caption: string;
  hashtags: string[];
  callToAction: string | null;
  mediaType: string | null;
  mediaPrompt: string | null;
  status: ContentStatus;
  media: { mediaId: string; position: number; media: MediaAsset }[];
}

export interface ScheduledPost {
  id: string;
  variantId: string;
  socialAccountId: string;
  scheduledAt: string;
  status: 'SCHEDULED' | 'QUEUED' | 'PUBLISHING' | 'PUBLISHED' | 'FAILED' | 'CANCELLED';
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  publishedPost: { platformPostId: string; url: string | null; publishedAt: string } | null;
  socialAccount: { id: string; platform: PlatformKey; displayName: string; isMock: boolean };
}

export interface Content {
  id: string;
  clientId: string;
  title: string;
  topic: string | null;
  objective: string | null;
  contentType: string;
  baseContent: string;
  status: ContentStatus;
  aiGenerated: boolean;
  missingInfo: string[];
  rejectionReason: string | null;
  scheduledAt: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  variants: Variant[];
  approvals: { id: string; status: string; comment: string | null; createdAt: string; decidedAt: string | null }[];
  scheduledPosts: ScheduledPost[];
  client?: { id: string; name: string };
}

export interface ContentListItem {
  id: string;
  clientId: string;
  title: string;
  status: ContentStatus;
  aiGenerated: boolean;
  scheduledAt: string | null;
  updatedAt: string;
  variants: { id: string; platform: PlatformKey; status: ContentStatus }[];
  client: { id: string; name: string };
}

export interface Paged<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ConversationListItem {
  id: string;
  clientId: string;
  platform: PlatformKey;
  type: 'DIRECT_MESSAGE' | 'COMMENT';
  status: 'OPEN' | 'PENDING' | 'ESCALATED' | 'RESOLVED' | 'SPAM';
  mode: 'AI' | 'HUMAN';
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
  unreadCount: number;
  lastMessageAt: string;
  lastMessagePreview: string | null;
  lastIntent: IntentKey | null;
  lastConfidence: number | null;
  assignedToId: string | null;
  contact: { id: string; name: string | null; username: string | null };
  socialAccount: { id: string; platform: PlatformKey; displayName: string; isMock: boolean };
  client: { id: string; name: string };
  leads: { id: string; status: string }[];
  suggestions: { id: string; confidence: number }[];
}

export interface Message {
  id: string;
  direction: 'INBOUND' | 'OUTBOUND';
  senderType: 'CONTACT' | 'USER' | 'AI' | 'SYSTEM';
  content: string;
  status: 'RECEIVED' | 'DRAFT' | 'PENDING' | 'SENT' | 'FAILED';
  intent: IntentKey | null;
  confidence: number | null;
  isSpam: boolean;
  error: string | null;
  createdAt: string;
}

export interface Suggestion {
  id: string;
  inboundMessageId: string;
  suggestedReply: string;
  intent: IntentKey;
  confidence: number;
  requiresHuman: boolean;
  reason: string;
  decision: string;
  decisionReason: string | null;
  createdAt: string;
}

export interface ConversationDetail extends Omit<ConversationListItem, 'leads' | 'suggestions' | 'socialAccount' | 'contact'> {
  contact: { id: string; name: string | null; username: string | null; email: string | null; phone: string | null; platformUserId: string | null; tags: string[]; notes: string | null };
  socialAccount: { id: string; platform: PlatformKey; displayName: string; username: string | null; isMock: boolean; status: string; capabilities: Capabilities };
  client: { id: string; name: string; timezone: string };
  summary: string | null;
  messages: Message[];
  suggestions: Suggestion[];
  escalations: { id: string; reason: string; createdAt: string }[];
  leads: Lead[];
}

export type LeadStatus = 'NEW' | 'CONTACTED' | 'QUALIFIED' | 'APPOINTMENT' | 'PROPOSAL' | 'WON' | 'LOST';

export interface Lead {
  id: string;
  clientId: string;
  contactId: string | null;
  conversationId: string | null;
  name: string | null;
  username: string | null;
  platform: PlatformKey | null;
  source: string;
  email: string | null;
  phone: string | null;
  interest: string | null;
  intent: IntentKey | null;
  confidence: number | null;
  status: LeadStatus;
  value: number | null;
  assignedToId: string | null;
  createdAt: string;
  client?: { name: string };
  contact?: { name: string | null; username: string | null } | null;
  notes?: { id: string; body: string; authorId: string; createdAt: string }[];
  conversation?: { id: string; platform: PlatformKey; lastMessagePreview: string | null } | null;
}

export interface Member {
  id: string;
  role: string;
  clientAccess: 'ALL' | 'ASSIGNED';
  clientIds: string[];
  user: { id: string; name: string; email: string; lastLoginAt: string | null };
}

export interface Notification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface KnowledgeSource {
  id: string;
  clientId: string;
  type: string;
  title: string;
  url: string | null;
  status: 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED';
  error: string | null;
  chunkCount: number;
  createdAt: string;
}

export interface AutomationRule {
  id: string;
  clientId: string | null;
  name: string;
  description: string | null;
  enabled: boolean;
  priority: number;
  trigger: 'MESSAGE_RECEIVED' | 'COMMENT_RECEIVED' | 'LEAD_CREATED' | 'POST_FAILED';
  platforms: PlatformKey[];
  conditions: { field: string; op: string; value: unknown }[];
  actions: { type: string; [k: string]: unknown }[];
  stopProcessing: boolean;
  _count?: { executions: number };
}

export interface Dashboard {
  scheduledPosts: number | null;
  publishedPosts30d: number | null;
  unreadMessages: number | null;
  newLeads: number | null;
  pendingApprovals: number | null;
  failedPosts30d: number | null;
  connectedAccounts: number | null;
  openEscalations: number | null;
}
