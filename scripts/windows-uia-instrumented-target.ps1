Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$logPath = $env:INTERPRETER_UIA_TARGET_LOG
if (-not $logPath) {
  $logPath = Join-Path $env:TEMP "interpreter-uia-target-events.jsonl"
}

$resultPath = $env:INTERPRETER_UIA_TARGET_RESULT
if (-not $resultPath) {
  $resultPath = Join-Path $env:TEMP "interpreter-uia-target-result.json"
}

$logDir = Split-Path -Parent $logPath
if ($logDir -and -not (Test-Path -LiteralPath $logDir)) {
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
}

function Write-TargetEvent {
  param([string]$Kind, [string]$Name, [object]$Value = $null)
  $event = [ordered]@{
    ts = [DateTimeOffset]::UtcNow.ToString("o")
    kind = $Kind
    name = $Name
    value = $Value
  }
  Add-Content -LiteralPath $logPath -Encoding UTF8 -Value ($event | ConvertTo-Json -Compress -Depth 6)
}

Set-Content -LiteralPath $logPath -Encoding UTF8 -Value ""
Write-TargetEvent "start" "window" "ready"

$form = New-Object System.Windows.Forms.Form
$form.Text = "Interpreter UIA Instrumented Target"
$form.StartPosition = "Manual"
$form.Location = New-Object System.Drawing.Point(180, 140)
$form.Size = New-Object System.Drawing.Size(760, 560)
$form.Font = New-Object System.Drawing.Font("Segoe UI", 10)

$title = New-Object System.Windows.Forms.Label
$title.Text = "Instrumented UIA Target"
$title.Font = New-Object System.Drawing.Font("Segoe UI", 18, [System.Drawing.FontStyle]::Bold)
$title.Location = New-Object System.Drawing.Point(28, 22)
$title.Size = New-Object System.Drawing.Size(520, 36)
$form.Controls.Add($title)

$textLabel = New-Object System.Windows.Forms.Label
$textLabel.Text = "Account Name"
$textLabel.Location = New-Object System.Drawing.Point(32, 84)
$textLabel.Size = New-Object System.Drawing.Size(180, 24)
$form.Controls.Add($textLabel)

$textBox = New-Object System.Windows.Forms.TextBox
$textBox.Name = "accountName"
$textBox.AccessibleName = "Account Name"
$textBox.Location = New-Object System.Drawing.Point(32, 112)
$textBox.Size = New-Object System.Drawing.Size(310, 30)
$textBox.Add_GotFocus({ Write-TargetEvent "focus" "Account Name" $textBox.Text })
$textBox.Add_TextChanged({ Write-TargetEvent "input" "Account Name" $textBox.Text })
$form.Controls.Add($textBox)

$comboLabel = New-Object System.Windows.Forms.Label
$comboLabel.Text = "Region"
$comboLabel.Location = New-Object System.Drawing.Point(390, 84)
$comboLabel.Size = New-Object System.Drawing.Size(160, 24)
$form.Controls.Add($comboLabel)

$combo = New-Object System.Windows.Forms.ComboBox
$combo.Name = "region"
$combo.AccessibleName = "Region"
$combo.DropDownStyle = [System.Windows.Forms.ComboBoxStyle]::DropDownList
[void]$combo.Items.Add("North")
[void]$combo.Items.Add("South")
[void]$combo.Items.Add("West")
$combo.Location = New-Object System.Drawing.Point(390, 112)
$combo.Size = New-Object System.Drawing.Size(260, 30)
$combo.Add_GotFocus({ Write-TargetEvent "focus" "Region" $combo.Text })
$combo.Add_SelectedIndexChanged({ Write-TargetEvent "change" "Region" $combo.Text })
$form.Controls.Add($combo)

$checkOne = New-Object System.Windows.Forms.CheckBox
$checkOne.Text = "Implementation planning"
$checkOne.AccessibleName = "Implementation planning"
$checkOne.Location = New-Object System.Drawing.Point(32, 184)
$checkOne.Size = New-Object System.Drawing.Size(250, 30)
$checkOne.Add_GotFocus({ Write-TargetEvent "focus" "Implementation planning" $checkOne.Checked })
$checkOne.Add_Click({ Write-TargetEvent "click" "Implementation planning" $checkOne.Checked })
$checkOne.Add_CheckedChanged({ Write-TargetEvent "change" "Implementation planning" $checkOne.Checked })
$form.Controls.Add($checkOne)

$checkTwo = New-Object System.Windows.Forms.CheckBox
$checkTwo.Text = "Data migration"
$checkTwo.AccessibleName = "Data migration"
$checkTwo.Location = New-Object System.Drawing.Point(320, 184)
$checkTwo.Size = New-Object System.Drawing.Size(220, 30)
$checkTwo.Add_GotFocus({ Write-TargetEvent "focus" "Data migration" $checkTwo.Checked })
$checkTwo.Add_Click({ Write-TargetEvent "click" "Data migration" $checkTwo.Checked })
$checkTwo.Add_CheckedChanged({ Write-TargetEvent "change" "Data migration" $checkTwo.Checked })
$form.Controls.Add($checkTwo)

$radio = New-Object System.Windows.Forms.RadioButton
$radio.Text = "Priority review"
$radio.AccessibleName = "Priority review"
$radio.Location = New-Object System.Drawing.Point(32, 238)
$radio.Size = New-Object System.Drawing.Size(220, 30)
$radio.Add_GotFocus({ Write-TargetEvent "focus" "Priority review" $radio.Checked })
$radio.Add_Click({ Write-TargetEvent "click" "Priority review" $radio.Checked })
$radio.Add_CheckedChanged({ Write-TargetEvent "change" "Priority review" $radio.Checked })
$form.Controls.Add($radio)

$notesLabel = New-Object System.Windows.Forms.Label
$notesLabel.Text = "Notes"
$notesLabel.Location = New-Object System.Drawing.Point(32, 302)
$notesLabel.Size = New-Object System.Drawing.Size(120, 24)
$form.Controls.Add($notesLabel)

$notes = New-Object System.Windows.Forms.TextBox
$notes.Name = "notes"
$notes.AccessibleName = "Notes"
$notes.Location = New-Object System.Drawing.Point(32, 330)
$notes.Size = New-Object System.Drawing.Size(620, 30)
$notes.Add_GotFocus({ Write-TargetEvent "focus" "Notes" $notes.Text })
$notes.Add_TextChanged({ Write-TargetEvent "input" "Notes" $notes.Text })
$form.Controls.Add($notes)

$status = New-Object System.Windows.Forms.Label
$status.Text = ""
$status.ForeColor = [System.Drawing.Color]::ForestGreen
$status.Font = New-Object System.Drawing.Font("Segoe UI", 10, [System.Drawing.FontStyle]::Bold)
$status.Location = New-Object System.Drawing.Point(32, 438)
$status.Size = New-Object System.Drawing.Size(360, 28)
$form.Controls.Add($status)

$submit = New-Object System.Windows.Forms.Button
$submit.Text = "Submit Instrumented Target"
$submit.AccessibleName = "Submit Instrumented Target"
$submit.Location = New-Object System.Drawing.Point(420, 424)
$submit.Size = New-Object System.Drawing.Size(230, 42)
$submit.Add_Click({
  $status.Text = "Submitted"
  $result = [ordered]@{
    accountName = $textBox.Text
    region = $combo.Text
    implementationPlanning = $checkOne.Checked
    dataMigration = $checkTwo.Checked
    priorityReview = $radio.Checked
    notes = $notes.Text
    status = $status.Text
  }
  Write-TargetEvent "click" "Submit Instrumented Target" $result
  $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $resultPath -Encoding UTF8
})
$form.Controls.Add($submit)
$form.AcceptButton = $submit

$form.Add_FormClosed({ Write-TargetEvent "closed" "window" "closed" })

[void]$form.ShowDialog()
