<template>
  <div class="dashboard-card-shell dashboard-card-shell--teal activity-chart-card">
    <h3 class="dashboard-card-title">服务器活跃度</h3>
    <canvas :ref="assignCanvasRef" class="activity-chart-canvas"></canvas>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  setCanvasRef: (element: HTMLCanvasElement | null) => void;
}>();

function assignCanvasRef(element: unknown) {
  props.setCanvasRef(element instanceof HTMLCanvasElement ? element : null);
}
</script>

<style scoped>
@import "./dashboard-card.css";

.activity-chart-card {
  min-height: 0;
}

.activity-chart-canvas {
  width: 100%;
  height: 220px;
}

@container dashboard-card (max-width: 420px) {
  .activity-chart-canvas {
    height: 180px;
  }
}
</style>
