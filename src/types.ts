// Response types of the /admin routes of needforheat-server-api (package needforheat/cockpit). Times are Unix seconds.

export type CampaignState = "planned" | "running" | "ended";
export type SourceState = "missing" | "waiting" | "ok" | "late";
export type AccountState = "invited" | "active" | "incomplete" | "attention";

export interface App {
  id: number;
  name: string;
  provisioning_url_template: string;
  oauth_redirect_url: string;
}

export interface DataSourceList {
  id: number;
  name: string;
  items: number;
}

export interface Campaign {
  id: number;
  name: string;
  app: string;
  info_url: string;
  start_time: number | null;
  end_time: number | null;
  state: CampaignState;
  data_source_list_id: number;
  data_source_list: string;
  accounts: number;
  activated: number;
}

export interface Overview {
  apps: App[];
  campaigns: Campaign[];
  data_source_lists: DataSourceList[];
  generated_at: number;
}

export interface Source {
  id: number;
  category: "device_type" | "energy_query_type" | "cloud_feed_type" | string;
  name: string;
  upload_schedule: string;
  notification_threshold: string;
}

export interface SourceStatus {
  source_id: number;
  instance?: string;
  activated_at: number | null;
  latest_upload: number | null;
  state: SourceState;
}

export interface AccountStatus {
  id: number;
  activated_at: number | null;
  state: AccountState;
  sources: SourceStatus[];
}

export interface CampaignStatus {
  campaign: Campaign;
  sources: Source[];
  accounts: AccountStatus[];
  totals: Record<AccountState, number>;
  generated_at: number;
}

export interface CampaignUpdate {
  info_url?: string;
  start_time?: number;
  end_time?: number;
}

export interface Invitation {
  account_id: number;
  invitation_url: string;
}

// Body of the existing POST /campaign route: app and data source list are looked up by name.
export interface NewCampaign {
  name: string;
  app: { name: string };
  info_url: string;
  start_time?: number;
  end_time?: number;
  data_source_list: { name: string };
}
