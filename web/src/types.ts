export type Scenario = {
  schema_version: "cosmo-A-1.0";
  meta: { id: string; title: string };
  environment: {
    altitude_km: number;
    inclination_deg: number;
    earth_angle0_deg: number;
    horizon_s: number;
    step_s: number;
    min_elevation_deg: number;
    isl_range_km: number;
    target_availability: number;
  };
  design: {
    launch_stage: number;
    planes: { id: string; raan_deg: number; phase_deg: number }[];
    satellites: {
      id: string;
      plane_id: string;
      slot_deg: number;
      launch_batch: number;
    }[];
  };
  ground_sites: {
    id: string;
    name: string;
    role: "client" | "gateway";
    lat_deg: number;
    lon_deg: number;
  }[];
  failures: { satellite_id: string; start_s: number; end_s: number }[];
  gateway_outages: { gateway_id: string; start_s: number; end_s: number }[];
};
export type Reason =
  | "connected"
  | "no_client_coverage"
  | "all_gateways_offline"
  | "no_gateway_contact"
  | "isl_disconnected";
export type Sample = {
  t_s: number;
  client_id: string;
  path: string[];
  hop_count: number | null;
  distance_km: number | null;
  gateway_id: string | null;
  visible_satellite_ids: string[];
  reason: Reason;
  facts?: {
    client_has_coverage: boolean;
    any_gateway_online: boolean;
    any_gateway_contact: boolean;
    client_component_ids: number[];
    gateway_component_ids: number[];
    gateway_contacts: Record<string, string[]>;
  };
};
export type Outage = {
  start_s: number;
  end_s: number;
  duration_s: number;
  reason_samples: Partial<Record<Reason, number>>;
};
export type ClientSummary = {
  sample_count: number;
  visible_samples: number;
  reachable_samples: number;
  coverage: number;
  availability: number;
  target_met: boolean;
  target_margin: number;
  outage_count: number;
  total_outage_s: number;
  max_outage_s: number;
  outages: Outage[];
  hop_min: number | null;
  hop_max: number | null;
  hop_mean: number | null;
  distance_mean_km: number | null;
  route_switches: number;
  reason_samples: Partial<Record<Reason, number>>;
};
export type Summary = {
  sample_count: number;
  clients: Record<string, ClientSummary>;
  all_clients_target_met: boolean;
};
export type Run = {
  id: string;
  revision_id: string;
  status:
    | "queued"
    | "running"
    | "cancelling"
    | "cancelled"
    | "completed"
    | "interrupted"
    | "failed";
  title: string;
  progress: number;
  total: number;
  created_at: string;
  finished_at: string | null;
  error: string | null;
  summary: Summary | null;
  effective_scenario?: Scenario;
  scenario_hash: string;
};
export type RunResult = {
  effective_scenario: Scenario;
  summary: Summary;
  series: Record<string, Sample[]>;
  network: Network[];
  provenance: {
    engine_version: string;
    geometry_sha256: string;
    scenario_sha256: string;
    routing_policy: string;
    elapsed_s: number;
  };
};
export type Network = {
  t_s: number;
  active_satellites: number;
  isl_edges: number;
  ground_edges: number;
  component_count: number;
  online_gateways: string[];
  components?: string[][];
};
export type Satellite = {
  id: string;
  x_km: number;
  y_km: number;
  z_km: number;
  active: boolean;
  plane_id: string;
  launch_batch: number;
  state: "active" | "not_launched" | "failed";
};
export type Ground = Scenario["ground_sites"][number] & {
  x_km: number;
  y_km: number;
  z_km: number;
  online: boolean;
};
export type Snapshot = {
  run_id: string;
  index: number;
  t_s: number;
  satellites: Satellite[];
  ground_sites: Ground[];
  edges: [string, string, number][];
  elevation_deg: Record<string, Record<string, number>>;
  clients: Record<string, Sample>;
  network: Network;
};
export type Issue = { path: string; message: string; code?: string };
