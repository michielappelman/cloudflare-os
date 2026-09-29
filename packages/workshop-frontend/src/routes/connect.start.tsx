import { createFileRoute } from '@tanstack/react-router'
import ConnectStartPage from '../ConnectStartPage'

export const Route = createFileRoute('/connect/start')({
  component: ConnectStartPage,
})
