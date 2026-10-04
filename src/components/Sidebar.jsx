import { useStore } from '../lib/store';
import Explorer from './Explorer.jsx';
import SearchPanel from './SearchPanel.jsx';

export default function Sidebar() {
  const view = useStore((s) => s.layout.sidebarView);
  return view === 'search' ? <SearchPanel /> : <Explorer />;
}
