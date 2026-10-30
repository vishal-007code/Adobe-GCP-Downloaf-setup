import type { AdobeRegion } from './regions';

export type AdobeAccount = {
  email: string;
  password: string;
  // Picks the postcard template the account downloads (see regions.ts).
  region: AdobeRegion;
};

export type AdobeAccountSource =
  | {
      kind: 'csv';
      description: string;
      path: string;
    }
  | {
      kind: 'env';
      description: string;
    };

export type FreshAdobeAccountsResult = {
  accounts: AdobeAccount[];
  source: AdobeAccountSource;
  skipReason?: string;
};

export type AdobeResultStatus = 'passed' | 'skipped' | 'failed';

export type AdobeResultRow = {
  timestamp: string;
  email: string;
  test_status: AdobeResultStatus;
  logged_in: string;
  dashboard_url: string;
  owner_entity: string;
  failed_at_step: string;
  failure_reason: string;
  duration_ms: string;
  published_link: string;
  download_file: string;
  downloaded: string;
  outcome: string;
  login_s: string;
  editor_open_s: string;
  export_s: string;
  editor_reloads: string;
  region: string;
};

export type AdobeConsumedRow = {
  email: string;
  consumed_at: string;
};

export type StepTracker = {
  setStep(step: string): void;
  getStep(): string | undefined;
};
