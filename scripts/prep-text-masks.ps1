param([string]$DocsDir, [string]$MaskDir, [string]$ListFile)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -AssemblyName System.Drawing

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($op, $type) {
  $method = $asTaskGeneric.MakeGenericMethod($type)
  $task = $method.Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}

[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null

$language = [Windows.Globalization.Language]::new('zh-Hans-CN')
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
if ($engine -eq $null) { throw 'OCR engine unavailable for zh-Hans-CN' }

$paths = Get-Content -Path $ListFile -Raw -Encoding UTF8 | ConvertFrom-Json
$results = @()
foreach ($p in $paths) {
  $f = Get-Item -LiteralPath $p
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($f.FullName)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $ocr = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

  $image = [System.Drawing.Image]::FromFile($f.FullName)
  $mask = New-Object System.Drawing.Bitmap ([int]$image.Width), ([int]$image.Height)
  $graphics = [System.Drawing.Graphics]::FromImage($mask)
  $graphics.Clear([System.Drawing.Color]::Black)
  $brush = [System.Drawing.Brushes]::White
  $words = @()
  foreach ($line in $ocr.Lines) {
    foreach ($word in $line.Words) {
      $r = $word.BoundingRect
      $pad = 10
      $graphics.FillRectangle($brush, [int][Math]::Max(0, $r.X - $pad), [int][Math]::Max(0, $r.Y - $pad), [int]($r.Width + 2 * $pad), [int]($r.Height + 2 * $pad))
      $words += $word.Text
    }
  }
  $graphics.Dispose()
  $maskPath = Join-Path $MaskDir ($f.BaseName + '.png')
  $mask.Save($maskPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $mask.Dispose()
  $image.Dispose()

  $results += [pscustomobject]@{
    source = $f.Name
    mask = (Split-Path $maskPath -Leaf)
    wordCount = $words.Count
    text = ($words -join ' ')
  }
  Write-Output ('OCR done: ' + $f.Name + ' words=' + $words.Count)
}
$results | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $DocsDir 'ocr.json') -Encoding UTF8
