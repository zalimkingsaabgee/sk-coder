import { useIDEStore } from "@/store/ideStore";
import type { ActivePanel } from "@/types/ide";
const NAV_ITEMS: {
    id: ActivePanel;
    title: string;
    icon: React.ReactNode;
}[] = [
    {
        id: "files",
        title: "Files",
        icon: (<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
      </svg>),
    },
    {
        id: "editor",
        title: "Editor",
        icon: (<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
        <polyline points="16 18 22 12 16 6"/>
        <polyline points="8 6 2 12 8 18"/>
      </svg>),
    },
    {
        id: "preview",
        title: "Preview",
        icon: (<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
        <rect x="2" y="3" width="20" height="14" rx="2"/>
        <line x1="8" y1="21" x2="16" y2="21"/>
        <line x1="12" y1="17" x2="12" y2="21"/>
      </svg>),
    },
    {
        id: "ai",
        title: "AI",
        icon: (<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
        <rect x="3" y="3" width="18" height="18" rx="4"/>
        <path d="M9 9h.01M15 9h.01M9 15h6"/>
      </svg>),
    },
    {
        id: "terminal",
        title: "Terminal",
        icon: (<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
        <polyline points="4 17 10 11 4 5"/>
        <line x1="12" y1="19" x2="20" y2="19"/>
      </svg>),
    },
    {
        id: "apk",
        title: "APK",
        icon: (<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="none">
        <path d="M17.523 15.341a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm-11.046 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM15.65 4.826l1.521-2.634a.5.5 0 0 0-.866-.5l-1.54 2.668A8.943 8.943 0 0 0 12 4c-.96 0-1.882.156-2.742.434L7.695 1.692a.5.5 0 0 0-.866.5L8.35 4.826C5.84 6.124 4 8.617 4 11.5h16c0-2.883-1.84-5.376-4.35-6.674z"/>
      </svg>),
    },
    {
        id: "cloud",
        title: "GitHub",
        icon: (<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
        <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/>
      </svg>),
    },
];
export default function BottomNav() {
    const { activePanel, setActivePanel, sidebarOpen, setSidebarOpen, errors } = useIDEStore();
    function handleNav(id: ActivePanel) {
        if (id === "files" && activePanel === "editor") {
            if (sidebarOpen) {
                setSidebarOpen(false);
                return;
            }
            setActivePanel("files");
            return;
        }
        if (id === "files") {
            setSidebarOpen(false);
            setActivePanel("files");
        }
        else {
            setSidebarOpen(false);
            setActivePanel(id);
        }
    }
    const errorCount = errors.filter((e) => e.severity === "error").length;
    return (<nav className="bottom-nav">
      {NAV_ITEMS.map((item) => {
            const isActive = item.id === "files" ? activePanel === "files" : activePanel === item.id && !sidebarOpen;
            return (<button key={item.id} className={`bottom-nav-item ${isActive ? "active" : ""}`} onClick={() => handleNav(item.id)} title={item.title} style={{ position: "relative" }}>
            {item.icon}
            {item.id === "editor" && errorCount > 0 && (<span style={{
                        position: "absolute", top: 2, right: 2,
                        width: 8, height: 8, borderRadius: "50%",
                        background: "#f38ba8", border: "1px solid var(--bg-primary)",
                    }}/>)}
          </button>);
        })}
    </nav>);
}
