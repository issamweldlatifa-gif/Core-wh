import { useOutletContext } from 'react-router-dom';
import type { OpsOverview } from './api';

/**
 * Live data shared between the Admin shell top bar and the Control Center
 * pages: ONE overview request, polled at the shell level (§15), served to
 * every consumer through the router Outlet context.
 */
export interface ControlData {
  overview: OpsOverview | null;
  loading: boolean;
  error: string | null;
  lastUpdated: string | null;
  reload: () => void;
}

export function useControlData(): ControlData {
  return useOutletContext<ControlData>();
}
