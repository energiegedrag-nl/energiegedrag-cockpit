import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getToken, setToken } from "./api";
import { Login } from "./pages/Login";
import { OverviewPage } from "./pages/OverviewPage";
import { CampaignPage } from "./pages/CampaignPage";
import { NewCampaignPage } from "./pages/NewCampaignPage";
import { FlashStationPage } from "./pages/FlashStationPage";
import { InventoryDevicePage, InventoryPage } from "./pages/InventoryPage";

type Route =
  | { page: "overview" }
  | { page: "campaign"; id: number }
  | { page: "new" }
  | { page: "flash" }
  | { page: "inventory" }
  | { page: "device"; id: number };

function parseRoute(hash: string): Route {
  const campaign = /^#\/campagne\/(\d+)$/.exec(hash);
  if (campaign) return { page: "campaign", id: Number(campaign[1]) };
  const device = /^#\/voorraad\/(\d+)$/.exec(hash);
  if (device) return { page: "device", id: Number(device[1]) };
  if (hash === "#/nieuw") return { page: "new" };
  if (hash === "#/flashstation") return { page: "flash" };
  if (hash === "#/voorraad") return { page: "inventory" };
  return { page: "overview" };
}

export function App() {
  const [token, setTokenState] = useState(getToken());
  const [route, setRoute] = useState(parseRoute(location.hash));
  const queryClient = useQueryClient();

  useEffect(() => {
    const onHash = () => setRoute(parseRoute(location.hash));
    const onLogout = () => setTokenState(null);
    window.addEventListener("hashchange", onHash);
    window.addEventListener("cockpit:logout", onLogout);
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("cockpit:logout", onLogout);
    };
  }, []);

  if (!token) {
    return (
      <Login
        onLogin={(t) => {
          setToken(t);
          setTokenState(t);
        }}
      />
    );
  }

  const logout = () => {
    setToken(null);
    queryClient.clear();
    setTokenState(null);
  };

  return (
    <div className="shell">
      <header className="topbar">
        <a href="#/" className="brand">
          <span className="brand-mark" aria-hidden="true" />
          Energiegedrag Cockpit
        </a>
        <nav className="topnav">
          <a href="#/" aria-current={route.page === "overview" ? "page" : undefined}>
            Campagnes
          </a>
          <a href="#/nieuw" aria-current={route.page === "new" ? "page" : undefined}>
            Nieuwe campagne
          </a>
          <a href="#/flashstation" aria-current={route.page === "flash" ? "page" : undefined}>
            Flashstation
          </a>
          <a href="#/voorraad" aria-current={route.page === "inventory" || route.page === "device" ? "page" : undefined}>
            Voorraad
          </a>
          <button type="button" className="link" onClick={logout}>
            Uitloggen
          </button>
        </nav>
      </header>
      <main className="content">
        {route.page === "overview" && <OverviewPage />}
        {route.page === "campaign" && <CampaignPage id={route.id} />}
        {route.page === "new" && <NewCampaignPage />}
        {route.page === "flash" && <FlashStationPage />}
        {route.page === "inventory" && <InventoryPage />}
        {route.page === "device" && <InventoryDevicePage key={route.id} id={route.id} />}
      </main>
    </div>
  );
}
