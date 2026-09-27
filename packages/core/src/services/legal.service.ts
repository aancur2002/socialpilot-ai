import { getPlatformGroup } from './platform-settings.service';

/**
 * Terms of Service and Privacy Policy shown at /terms and /privacy. The platform
 * admin can paste their own text (Markdown) in Platform admin → Legal; until then
 * a starting template filled with the company details is shown. The templates are
 * a starting point, not legal advice: have them reviewed for your country.
 */

function fill(template: string, v: Record<string, string>) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => v[k] ?? '');
}

const TERMS = `# Terms of Service

These terms are an agreement between you (the "Customer") and {{company}} ("we", "us") for use of {{product}} (the "Service"). By creating an account or using the Service you accept them.

## 1. The Service
{{product}} helps businesses plan and publish social media content, manage messages and comments, and track leads, with the help of AI. Features depend on your plan.

## 2. Accounts
You are responsible for the people you invite, for keeping passwords secret, and for everything done under your account. Tell us at {{email}} straight away if you think your account has been misused.

## 3. Connected social accounts
You may connect only social accounts you are authorized to manage. Publishing and messaging happen through each platform's official interfaces and are also subject to that platform's terms (for example Meta, LinkedIn and TikTok). We are not responsible for a platform's decisions, outages or changes.

## 4. AI features
AI suggestions can be wrong. You decide what is published or sent, and you remain responsible for content published or sent from your accounts, including replies sent automatically under rules you set.

## 5. Acceptable use
You must not use the Service to send spam, to harass or deceive people, to break the law or anyone's rights, or to attack or overload the Service.

## 6. Plans, payment and suspension
Prices and limits are shown when you subscribe and on your billing page. Fees are payable in advance for each period. If payment is overdue beyond the grace period, or these terms are broken, we may pause the account; your data is kept and access returns once the issue is resolved. Fees already paid are not refundable unless the law requires otherwise.

## 7. Your data
You own the content and data you put into the Service. You give us permission to process it only to provide the Service, as described in our Privacy Policy. You can export your leads at any time. When your account is closed we delete your data within 90 days, except where the law requires us to keep it.

## 8. Availability and changes
We work to keep the Service available and secure but do not guarantee it will be uninterrupted or error-free. We may change features; we will give reasonable notice of changes that materially reduce what you pay for.

## 9. Liability
To the extent the law allows, the Service is provided "as is", we are not liable for indirect or consequential loss or for lost profits, and our total liability is limited to the fees you paid in the 12 months before the claim.

## 10. Ending the agreement
You may stop using the Service at any time. We may end the agreement with 30 days' notice, or immediately for a serious breach.

## 11. Law
These terms are governed by the laws of {{jurisdiction}}.

## 12. Contact
{{company}}{{address}}
Email: {{email}}
`;

const PRIVACY = `# Privacy Policy

This policy explains how {{company}} ("we") handles personal data in {{product}} (the "Service").

## Who is responsible
For account data (the people who sign in), we are the controller. For data our customers put into the Service about their own customers (messages, comments, leads), our customer is the controller and we process it on their behalf and on their instructions.

## What we collect
- **Account data:** name, email address, password (stored only as a secure hash), organization and role.
- **Connected social accounts:** account names and IDs, and access tokens granted by the platform, stored encrypted.
- **Content and messages:** posts you create and the comments and messages your connected accounts receive.
- **Leads:** details people submit through your forms or messages, such as name, email, phone and their message.
- **Usage and security data:** IP address, browser, sign-in times and an audit log of important actions.

## How we use it
To provide and secure the Service, to publish and receive content on your behalf, to generate AI suggestions, to send service emails (invitations, password resets, notifications), to bill you, and to meet legal obligations. We do not sell personal data.

## AI processing
To generate drafts and replies, relevant text (such as a message and your business information) is sent to the AI provider configured for your organization. Providers are chosen for data protection terms; please check your provider's policy for how it handles requests.

## Sharing
With service providers we need to run the Service (hosting, email delivery, AI providers, payment processors), with social platforms when you publish or reply, and where the law requires it. Each provider may use the data only to provide their service to us.

## Data from social platforms
Data received from platforms such as Facebook, Instagram, WhatsApp, LinkedIn and TikTok is used only to provide the features you use, is not sold or used for advertising, and is deleted when you disconnect the account or ask us to.

## Retention
We keep data while your account is active. After an account is closed we delete it within 90 days, except records we must keep by law (for example invoices).

## Security
Encryption in transit (HTTPS) and at rest for tokens and keys, access controls by role and client, audit logging and regular backups.

## Your rights
Depending on where you live you can ask to access, correct, delete or export your personal data, or object to its processing. Contact us at {{email}}. If someone's data was collected by one of our customers, we will pass the request to that customer.

## Deleting your data
Email {{email}} from your account's email address and we will delete your account data within 30 days. Social platform data is also deleted when you disconnect the account in the Service.

## Changes
We will post changes here and update the date above.

## Contact
{{company}}{{address}}
Email: {{email}}
`;

export async function publicLegal() {
  const [company, legal] = await Promise.all([getPlatformGroup('company'), getPlatformGroup('legal')]);
  const v = {
    company: company.legalName ?? company.productName,
    product: company.productName,
    email: company.supportEmail ?? '(support email not set)',
    address: company.address ? `\n${company.address}` : '',
    jurisdiction: company.jurisdiction ?? '(jurisdiction not set)',
  };
  return {
    productName: company.productName,
    updatedOn: legal.updatedOn,
    terms: legal.terms ?? fill(TERMS, v),
    privacy: legal.privacy ?? fill(PRIVACY, v),
    customTerms: Boolean(legal.terms),
    customPrivacy: Boolean(legal.privacy),
  };
}
