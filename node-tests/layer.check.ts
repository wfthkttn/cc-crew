import { dirname } from 'node:path'

import { checkLayer } from '../../cc-mods/check-layer.ts'

checkLayer(dirname(import.meta.dirname))
