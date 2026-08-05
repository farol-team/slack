import { Routes, Route } from 'react-router'
import Home from './pages/Home'
import Login from "./pages/Login"
import RunnerConnect from "./pages/RunnerConnect"
import NotFound from "./pages/NotFound"
import DashboardLayout from "./pages/dashboard/DashboardLayout"
import Dashboard from "./pages/dashboard/Dashboard"
import Runners from "./pages/dashboard/Runners"
import Memory from "./pages/dashboard/Memory"
import Settings from "./pages/dashboard/Settings"

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/login" element={<Login />} />
      <Route path="/runner/connect" element={<RunnerConnect />} />
      <Route path="/dashboard" element={<DashboardLayout />}>
        <Route index element={<Dashboard />} />
        <Route path="runners" element={<Runners />} />
        <Route path="memory" element={<Memory />} />
        <Route path="settings" element={<Settings />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  )
}
