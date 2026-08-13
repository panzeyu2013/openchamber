import { create } from 'zustand';

/**
 * Page-local UI state for the Servers settings page (selected connection and
 * add-form visibility). Deliberately NOT in the global UI store: the state is
 * only meaningful while the Servers page is open, and keeping it here avoids
 * touching shared store contracts.
 */
interface ServersUiState {
  selectedConnectionId: string | null;
  addFormOpen: boolean;
  setSelectedConnectionId: (id: string | null) => void;
  setAddFormOpen: (open: boolean) => void;
}

export const useServersUiStore = create<ServersUiState>((set) => ({
  selectedConnectionId: null,
  addFormOpen: false,
  setSelectedConnectionId: (selectedConnectionId) => set({ selectedConnectionId }),
  setAddFormOpen: (addFormOpen) => set({ addFormOpen }),
}));
