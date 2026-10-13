import { expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const include = fileURLToPath(
  new URL('../installer/prerequisites.nsh', import.meta.url),
)

test.skipIf(process.platform !== 'win32' || !process.env.MODELBRIDGE_TEST_NSIS)(
  'compiled prerequisite page blocks a missing host CLI, allows clients, rechecks and gates unattended hosting',
  async () => {
    const compiler = process.env.MODELBRIDGE_TEST_NSIS
    if (!compiler) throw new Error('Set MODELBRIDGE_TEST_NSIS to makensis.exe.')
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'modelbridge-nsis-'),
    )

    const script = path.join(directory, 'fixture.nsi')
    const executable = path.join(directory, 'fixture.exe')
    const marker = path.join(directory, 'cli-ready')
    const result = path.join(directory, 'result')
    const probes = path.join(directory, 'probes')
    const source = `
Unicode true
Name "ModelBridge prerequisite test"
OutFile "${executable}"
RequestExecutionLevel user
AutoCloseWindow true
!include "MUI2.nsh"
!macro ModelBridgeDetectDevTunnel
  FileOpen $2 "${probes}" a
  FileSeek $2 0 END
  FileWrite $2 "probe$\\r$\\n"
  FileClose $2
  StrCpy $MBReady "0"
  StrCpy $MBDescription "Not found. Install Microsoft's CLI separately, then click Recheck."
  IfFileExists "${marker}" 0 +3
    StrCpy $MBReady "1"
    StrCpy $MBDescription "Ready: isolated CLI fixture"
!macroend
!include "${include}"
!insertmacro customPageAfterChangeDir
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
Function .onInit
  !insertmacro customInit
FunctionEnd
Section
  FileOpen $2 "${result}" w
  FileWrite $2 "$MBHost:$MBReady"
  FileClose $2
SectionEnd
`
    const run = async (
      args: string[] = [],
      env: NodeJS.ProcessEnv = process.env,
    ) => {
      const child = Bun.spawn([executable, ...args], {
        env,
        stdout: 'ignore',
        stderr: 'ignore',
      })
      const deadline = Date.now() + 20_000
      while (child.exitCode === null && Date.now() < deadline)
        await Bun.sleep(100)
      if (child.exitCode === null) {
        child.kill()
        await child.exited
        throw new Error('Installer fixture timed out.')
      }
      return child.exited
    }
    const interact = async (action: 'client' | 'recheck' | 'cancel') => {
      const child = Bun.spawn([executable], {
        stdout: 'ignore',
        stderr: 'ignore',
      })
      try {
        const automation = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type 'using System; using System.Runtime.InteropServices; public static class MBTestClick { [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l); }'
$deadline = [DateTime]::UtcNow.AddSeconds(15)
$root = $null
while ([DateTime]::UtcNow -lt $deadline) {
  $process = Get-Process -Id ${child.pid} -ErrorAction Stop
  if ($process.MainWindowHandle -ne 0) {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
    $buttons = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    if (@($buttons | Where-Object { $_.Current.Name -eq 'Recheck' }).Count -eq 1) { break }
  }
  Start-Sleep -Milliseconds 100
}
if (!$root) { throw 'Installer prerequisite page did not open.' }
function FindControl($property, $value) {
  $control = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition($property, $value)))
  if (!$control) { throw "Control missing: $value" }
  return $control
}
function Click($control) {
  [void][MBTestClick]::PostMessage([IntPtr]$control.Current.NativeWindowHandle, 0xF5, [IntPtr]::Zero, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 200
}
$next = FindControl ([System.Windows.Automation.AutomationElement]::AutomationIdProperty) '1'
if ($next.Current.IsEnabled) { throw 'Missing host prerequisite did not block Install.' }
$link = FindControl ([System.Windows.Automation.AutomationElement]::NameProperty) "Open Microsoft's installation instructions"
if ('${action}' -eq 'client') {
  Click (FindControl ([System.Windows.Automation.AutomationElement]::NameProperty) 'Client-only for now (URL and key; no CLI required)')
  if (!$next.Current.IsEnabled) { throw 'Client-only installation was incorrectly blocked.' }
  Click $next
} elseif ('${action}' -eq 'recheck') {
  [IO.File]::WriteAllText('${marker}', 'installed separately')
  Click (FindControl ([System.Windows.Automation.AutomationElement]::NameProperty) 'Recheck')
  if (!$next.Current.IsEnabled) { throw 'Recheck did not unblock host installation.' }
  Click $next
} else {
  Click (FindControl ([System.Windows.Automation.AutomationElement]::AutomationIdProperty) '2')
  Start-Sleep -Milliseconds 200
  $dialog = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)))
  if ($dialog) {
    $yes = $dialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, '6')))
    if ($yes) { Click $yes }
  }
}
`
        const driver = Bun.spawn(
          [
            'powershell.exe',
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            automation,
          ],
          { stdout: 'pipe', stderr: 'pipe' },
        )
        const output = await new Response(driver.stderr).text()
        expect(await driver.exited, output).toBe(0)
        const deadline = Date.now() + 10_000
        while (child.exitCode === null && Date.now() < deadline)
          await Bun.sleep(100)
        expect(child.exitCode).toBe(action === 'cancel' ? 1 : 0)
      } finally {
        if (child.exitCode === null) child.kill()
        await child.exited
      }
    }
    const compile = async (input: string) => {
      fs.writeFileSync(script, input)
      const compilation = Bun.spawn([compiler, '/V2', script], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const output = await new Response(compilation.stdout).text()
      const errors = await new Response(compilation.stderr).text()
      expect(await compilation.exited, `${output}\n${errors}`).toBe(0)
    }
    try {
      await compile(source)
      await interact('client')
      expect(fs.readFileSync(result, 'utf8')).toBe('0:0')
      fs.unlinkSync(result)
      fs.unlinkSync(probes)
      await interact('recheck')
      expect(fs.readFileSync(result, 'utf8')).toBe('1:1')
      expect(
        fs.readFileSync(probes, 'utf8').trim().split(/\r?\n/u),
      ).toHaveLength(3)
      fs.unlinkSync(marker)
      fs.unlinkSync(result)
      await interact('cancel')
      expect(fs.existsSync(result)).toBe(false)
      expect(await run(['/S'])).toBe(0)
      expect(fs.readFileSync(result, 'utf8')).toBe('0:0')
      fs.unlinkSync(result)
      expect(await run(['/S', '/HOST'])).toBe(2)
      expect(fs.existsSync(result)).toBe(false)
      fs.writeFileSync(marker, 'installed separately')
      expect(await run(['/S', '/HOST'])).toBe(0)
      expect(fs.readFileSync(result, 'utf8')).toBe('1:1')
      fs.unlinkSync(result)
      const cliDirectory = path.join(directory, 'CLI with spaces')
      fs.mkdirSync(cliDirectory)
      const cli = path.join(cliDirectory, 'devtunnel.exe')
      const env = { ...process.env, PATH: `"${cliDirectory}"` }
      await compile(
        source.replace(
          /!macro ModelBridgeDetectDevTunnel[\s\S]*?!macroend/u,
          '',
        ),
      )
      fs.writeFileSync(cli, 'not an executable')
      expect(await run(['/S', '/HOST'], env)).toBe(2)
      expect(fs.existsSync(result)).toBe(false)
      const compileCli = async (output: string, code: number) => {
        const cliScript = path.join(directory, 'cli.nsi')
        fs.writeFileSync(
          cliScript,
          `
Unicode true
Name "Isolated CLI probe fixture"
OutFile "${cli}"
RequestExecutionLevel user
SilentInstall silent
Section
  System::Call 'kernel32::GetStdHandle(i -11) p .r0'
  FileWrite $0 "${output}"
  SetErrorLevel ${code}
SectionEnd
`,
        )
        const compiled = Bun.spawn([compiler, '/V2', cliScript], {
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const stdout = await new Response(compiled.stdout).text()
        const stderr = await new Response(compiled.stderr).text()
        expect(await compiled.exited, `${stdout}\n${stderr}`).toBe(0)
      }
      await compileCli('Not a tunnel CLI', 0)
      expect(await run(['/S', '/HOST'], env)).toBe(2)
      expect(fs.existsSync(result)).toBe(false)
      await compileCli('Dev Tunnels CLI fixture', 1)
      expect(await run(['/S', '/HOST'], env)).toBe(2)
      expect(fs.existsSync(result)).toBe(false)
      await compileCli('Dev Tunnels CLI fixture', 0)
      expect(await run(['/S', '/HOST'], env)).toBe(0)
      expect(fs.readFileSync(result, 'utf8')).toBe('1:1')
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
  120_000,
)

test.skipIf(
  process.platform !== 'win32' || !process.env.MODELBRIDGE_TEST_INSTALLER_EXE,
)(
  'full development installer exposes the host/client prerequisite page and cancels before installing',
  async () => {
    const executable = process.env.MODELBRIDGE_TEST_INSTALLER_EXE
    if (!executable) throw new Error('Set MODELBRIDGE_TEST_INSTALLER_EXE.')
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'modelbridge-wizard-'),
    )
    const child = Bun.spawn(
      [
        executable,
        '/currentuser',
        `/D=${path.join(directory, 'installation')}`,
      ],
      { stdout: 'ignore', stderr: 'ignore' },
    )
    try {
      const driver = Bun.spawn(
        [
          'powershell.exe',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type 'using System; using System.Runtime.InteropServices; public static class MBWizardClick { [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l); }'
$root = $null
$deadline = [DateTime]::UtcNow.AddSeconds(20)
while ([DateTime]::UtcNow -lt $deadline) {
  $process = Get-Process -Id ${child.pid} -ErrorAction Stop
  if ($process.MainWindowHandle -ne 0) {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
    $recheck = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, 'Recheck')))
    if ($recheck) { break }
  }
  Start-Sleep -Milliseconds 100
}
if (!$recheck) { throw 'Full installer prerequisite page did not open.' }
function FindControl($property, $value) {
  $control = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition($property, $value)))
  if (!$control) { throw "Control missing: $value" }
  return $control
}
function Click($control) {
  [void][MBWizardClick]::PostMessage([IntPtr]$control.Current.NativeWindowHandle, 0xF5, [IntPtr]::Zero, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 300
}
$hostRadio = FindControl ([System.Windows.Automation.AutomationElement]::NameProperty) 'Use as a host (requires Microsoft Dev Tunnels CLI)'
$clientRadio = FindControl ([System.Windows.Automation.AutomationElement]::NameProperty) 'Client-only for now (URL and key; no CLI required)'
$link = FindControl ([System.Windows.Automation.AutomationElement]::NameProperty) "Open Microsoft's installation instructions"
$next = FindControl ([System.Windows.Automation.AutomationElement]::AutomationIdProperty) '1'
$all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$ready = @($all | Where-Object { $_.Current.Name -like 'Ready:*devtunnel.exe' }).Count -eq 1
if ($next.Current.IsEnabled -ne $ready) { throw 'Host Install enablement disagrees with actual CLI status.' }
Click $clientRadio
if (!$next.Current.IsEnabled) { throw 'Client-only installation was blocked.' }
Click $hostRadio
if ($next.Current.IsEnabled -ne $ready) { throw 'Returning to host bypassed its prerequisite.' }
Click (FindControl ([System.Windows.Automation.AutomationElement]::AutomationIdProperty) '2')
$dialog = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)))
if ($dialog) {
  $yes = $dialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, '6')))
  if ($yes) { Click $yes }
}
Write-Output "WIZARD_OK CLI_READY=$ready"
`,
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      )
      const output = await new Response(driver.stdout).text()
      const errors = await new Response(driver.stderr).text()
      expect(await driver.exited, errors).toBe(0)
      expect(output).toContain('WIZARD_OK')
      if (process.env.MODELBRIDGE_TEST_EXPECT_CLI === '1')
        expect(output).toContain('CLI_READY=True')
      const deadline = Date.now() + 10_000
      while (child.exitCode === null && Date.now() < deadline)
        await Bun.sleep(100)
      expect(child.exitCode).toBe(1)
      expect(
        fs.existsSync(path.join(directory, 'installation', 'ModelBridge.exe')),
      ).toBe(false)
    } finally {
      if (child.exitCode === null) child.kill()
      await child.exited
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
  60_000,
)
