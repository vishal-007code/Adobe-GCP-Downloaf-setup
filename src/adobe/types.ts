export type AdobeAccount = {
  email: string;
  password: string;
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
};

export type AdobeConsumedRow = {
  email: string;
  consumed_at: string;
};

export type StepTracker = {
  setStep(step: string): void;
  getStep(): string | undefined;
};
