import { useState } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { Workspace } from './components/Workspace'
import type { Role } from './data/mock'

function App() {
  const [role, setRole] = useState<Role>('trader')

  return (
    <Routes>
      <Route path="/" element={<Workspace currentRole={role} onRoleChange={setRole} />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default App
