import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findWorkspaceInterpreters } from './python-environments'

function existing(...paths: string[]): (path: string) => boolean {
  return (path) => paths.includes(path)
}

describe('findWorkspaceInterpreters', () => {
  it('walks from the notebook folder to the workspace root, nearest env first', () => {
    const exists = existing(
      join('/repo/.venv/bin/python'),
      join('/repo/analysis/.conda/bin/python'),
      join('/.venv/bin/python')
    )
    expect(
      findWorkspaceInterpreters('/repo/analysis/week1/nb.ipynb', '/repo', 'darwin', exists)
    ).toEqual([join('/repo/analysis/.conda/bin/python'), join('/repo/.venv/bin/python')])
  })

  it('only looks beside the notebook when it is outside the workspace or there is none', () => {
    const exists = existing(join('/elsewhere/.venv/bin/python'), join('/.venv/bin/python'))
    expect(findWorkspaceInterpreters('/elsewhere/nb.ipynb', '/repo', 'linux', exists)).toEqual([
      join('/elsewhere/.venv/bin/python')
    ])
    expect(findWorkspaceInterpreters('/elsewhere/nb.ipynb', null, 'linux', exists)).toEqual([
      join('/elsewhere/.venv/bin/python')
    ])
  })

  it('uses Scripts\\\\python.exe for venvs and the env root for conda on Windows', () => {
    const exists = existing(join('/repo/.venv/Scripts/python.exe'), join('/repo/.conda/python.exe'))
    expect(findWorkspaceInterpreters('/repo/nb.ipynb', '/repo', 'win32', exists)).toEqual([
      join('/repo/.venv/Scripts/python.exe'),
      join('/repo/.conda/python.exe')
    ])
  })
})
